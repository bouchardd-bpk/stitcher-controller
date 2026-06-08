const { createApp } = Vue;
const API_BASE = globalThis.location.port === "5173" ? "http://localhost:8812" : "";
const SETTING_KEY_PATTERN = /^[A-Za-z_]\w*$/;

createApp({
  data() {
    return {
      loading: false,
      saving: false,
      testingUrl: false,
      activePanel: "config",
      statusRunning: false,
      statusOutput: "",
      saveMessage: "",
      testUrlValue: "http://localhost:1080/bpk-tv/jumping/dvr30sdefault/index.mpd",
      testResult: null,
      config: {
        default_settings: [],
        services: [],
        upstream_origin_endpoints: [],
      },
      backups: [],
      selectedLoadTarget: "current",
      loadConfigModal: null,
      pollTimer: null,
    };
  },
  computed: {
    statusBadgeClass() {
      return this.statusRunning ? "badge-running" : "badge-stopped";
    },
    testStatusClass() {
      if (!this.testResult) {
        return "text-bg-secondary";
      }
      return this.testResult.ok ? "text-bg-success" : "text-bg-danger";
    },
    endpointValidation() {
      return this.config.upstream_origin_endpoints.map((endpoint) => this.validateEndpoint(endpoint));
    },
    hasInvalidEndpoints() {
      return this.endpointValidation.some((item) => !item.ok);
    },
    defaultSettingValidation() {
      const keys = this.config.default_settings.map((setting) => String(setting.key ?? "").trim());
      return this.config.default_settings.map((setting, index) => {
        const key = keys[index];
        const value = String(setting.value ?? "").trim();
        if (!key) {
          return { ok: false, message: "Parameter name required" };
        }
        if (!SETTING_KEY_PATTERN.test(key)) {
          return { ok: false, message: "Use letters, digits, underscores (start with letter/underscore)" };
        }
        if (keys.filter((candidate) => candidate === key).length > 1) {
          return { ok: false, message: "Duplicate parameter name" };
        }
        if (!value) {
          return { ok: false, message: "Default value required" };
        }
        return { ok: true, message: "" };
      });
    },
    hasInvalidDefaultSettings() {
      return this.defaultSettingValidation.some((item) => !item.ok);
    },
    defaultSettingKeys() {
      return this.config.default_settings
        .map((setting) => String(setting.key ?? "").trim())
        .filter((key, index, source) => key && source.indexOf(key) === index);
    },
    serviceValidation() {
      const defaultSet = new Set(this.defaultSettingKeys);
      return this.config.services.map((service) => {
        const name = String(service.name ?? "").trim();
        if (!name) {
          return { ok: false, message: "Service name required" };
        }

        const keys = (service.settings || []).map((setting) => String(setting.key ?? "").trim());
        for (let idx = 0; idx < keys.length; idx += 1) {
          const key = keys[idx];
          const value = String(service.settings[idx]?.value ?? "").trim();
          if (!key) {
            return { ok: false, message: "Override parameter required" };
          }
          if (!defaultSet.has(key)) {
            return { ok: false, message: `Unknown parameter: ${key}` };
          }
          if (keys.filter((candidate) => candidate === key).length > 1) {
            return { ok: false, message: `Duplicate override: ${key}` };
          }
          if (!value) {
            return { ok: false, message: `Value required for ${key}` };
          }
        }

        return { ok: true, message: "" };
      });
    },
    hasInvalidServices() {
      return this.serviceValidation.some((item) => !item.ok);
    },
    canSaveConfig() {
      return !this.saving && !this.hasInvalidEndpoints && !this.hasInvalidDefaultSettings && !this.hasInvalidServices;
    },
    availableConfigTargets() {
      const targets = [{ value: "current", label: "Current config file" }];
      for (const backup of this.backups) {
        targets.push({ value: backup, label: backup });
      }
      return targets;
    },
  },
  methods: {
    stripOuterQuotes(value) {
      const current = String(value ?? "").trim();
      if (current.length >= 2 && current.startsWith('"') && current.endsWith('"')) {
        return current.slice(1, -1);
      }
      return current;
    },
    ensureQuoted(value) {
      return `"${this.stripOuterQuotes(value)}"`;
    },
    formatSettingValueForKey(key, value) {
      const trimmed = String(value ?? "").trim();
      if (String(key ?? "").trim().startsWith("param_")) {
        return this.ensureQuoted(trimmed);
      }
      return trimmed;
    },
    async api(path, options = {}) {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.detail ? JSON.stringify(body.detail, null, 2) : `HTTP Error ${response.status}`);
      }
      return body;
    },
    newService() {
      return {
        name: "new_service",
        settings: [],
      };
    },
    newDefaultSetting() {
      return {
        key: "",
        value: "",
      };
    },
    addDefaultSetting() {
      this.config.default_settings.push(this.newDefaultSetting());
    },
    removeDefaultSetting(index) {
      const removed = this.config.default_settings[index]?.key;
      this.config.default_settings.splice(index, 1);
      if (!removed) {
        return;
      }
      for (const service of this.config.services) {
        service.settings = (service.settings || []).filter((setting) => String(setting.key ?? "").trim() !== removed);
      }
    },
    addService() {
      this.config.services.push(this.newService());
    },
    removeService(index) {
      this.config.services.splice(index, 1);
    },
    addServiceOverride(service) {
      const defaultKeys = this.defaultSettingKeys;
      if (defaultKeys.length === 0) {
        return;
      }

      const usedKeys = new Set((service.settings || []).map((setting) => String(setting.key ?? "").trim()));
      const candidate = defaultKeys.find((key) => !usedKeys.has(key));
      if (!candidate) {
        return;
      }

      service.settings.push({ key: candidate, value: "" });
    },
    removeServiceOverride(service, index) {
      service.settings.splice(index, 1);
    },
    overrideOptions(service, currentKey) {
      const keyInRow = String(currentKey ?? "").trim();
      const used = new Set(
        (service.settings || [])
          .map((setting) => String(setting.key ?? "").trim())
          .filter((key) => key && key !== keyInRow),
      );

      const result = this.defaultSettingKeys.filter((key) => !used.has(key));
      if (keyInRow && !result.includes(keyInRow)) {
        result.unshift(keyInRow);
      }
      return result;
    },
    addEndpoint() {
      this.config.upstream_origin_endpoints.push("https://");
    },
    removeEndpoint(index) {
      this.config.upstream_origin_endpoints.splice(index, 1);
    },
    validateEndpoint(value) {
      const current = String(value ?? "").trim();
      if (!current) {
        return { ok: false, message: "Endpoint required" };
      }
      try {
        const parsed = new URL(current);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, message: "Use http:// or https://" };
        }
        if (!parsed.hostname) {
          return { ok: false, message: "Missing host" };
        }
      } catch {
        return { ok: false, message: "Invalid URL" };
      }
      return { ok: true, message: "" };
    },
    async loadStatus() {
      try {
        const data = await this.api("/api/status");
        this.statusRunning = data.running;
        this.statusOutput = `${data.status.stdout || ""}${data.status.stderr || ""}`.trim();
      } catch (error) {
        this.statusOutput = String(error.message || error);
      }
    },
    async runAction(action) {
      this.loading = true;
      this.saveMessage = "";
      try {
        const data = await this.api(`/api/control/${action}`, { method: "POST" });
        this.statusRunning = data.running;
        this.statusOutput = `${data.result.stdout || ""}${data.result.stderr || ""}`.trim();
      } catch (error) {
        this.statusOutput = String(error.message || error);
      } finally {
        this.loading = false;
      }
    },
    normalizeConfig(data) {
      const defaults = data.default_settings || {};
      this.config.default_settings = Object.entries(defaults).map(([key, value]) => ({
        key,
        value: String(key).startsWith("param_") ? this.stripOuterQuotes(value) : String(value ?? ""),
      }));

      this.config.services = (data.services || []).map((service) => ({
        name: service.name,
        settings: Object.entries(service.settings || {}).map(([key, value]) => ({
          key,
          value: String(key).startsWith("param_") ? this.stripOuterQuotes(value) : String(value ?? ""),
        })),
      }));
      this.config.upstream_origin_endpoints = data.upstream_origin_endpoints || [];
    },
    async loadConfig() {
      const data = await this.api("/api/config");
      this.normalizeConfig(data);
    },
    async loadBackups() {
      const data = await this.api("/api/backups");
      this.backups = data.backups || [];
      const targetExists = this.availableConfigTargets.some((target) => target.value === this.selectedLoadTarget);
      if (!targetExists) {
        this.selectedLoadTarget = "current";
      }
    },
    openLoadConfigModal() {
      if (!this.loadConfigModal) {
        return;
      }
      this.loadConfigModal.show();
    },
    closeLoadConfigModal() {
      if (!this.loadConfigModal) {
        return;
      }
      this.loadConfigModal.hide();
    },
    async loadSelectedConfig() {
      try {
        if (this.selectedLoadTarget === "current") {
          await this.loadConfig();
          this.saveMessage = "Current configuration loaded.";
        } else {
          await this.api(`/api/backups/${this.selectedLoadTarget}/restore`, { method: "POST" });
          await this.loadConfig();
          await this.loadBackups();
          this.saveMessage = `Loaded: ${this.selectedLoadTarget}`;
        }
        this.closeLoadConfigModal();
      } catch (error) {
        this.saveMessage = `Load error: ${String(error.message || error)}`;
      }
    },
    async saveConfig() {
      const normalizedDefaults = this.config.default_settings.map((setting) => ({
        key: String(setting.key ?? "").trim(),
        value: String(setting.value ?? "").trim(),
      }));
      const defaultValidation = normalizedDefaults.map((setting, index) => this.defaultSettingValidation[index] || { ok: true });
      const firstInvalidDefault = defaultValidation.findIndex((item) => !item.ok);
      if (firstInvalidDefault !== -1) {
        this.saveMessage = `Error: invalid default parameter at position ${firstInvalidDefault + 1}.`;
        return;
      }

      const normalizedServices = this.config.services.map((service) => ({
        name: String(service.name ?? "").trim(),
        settings: (service.settings || []).map((setting) => ({
          key: String(setting.key ?? "").trim(),
          value: String(setting.value ?? "").trim(),
        })),
      }));
      const firstInvalidService = this.serviceValidation.findIndex((item) => !item.ok);
      if (firstInvalidService !== -1) {
        this.saveMessage = `Error: invalid overrides for service ${firstInvalidService + 1}.`;
        return;
      }

      const normalizedEndpoints = this.config.upstream_origin_endpoints.map((value) => String(value ?? "").trim());
      const firstInvalidIndex = normalizedEndpoints.findIndex((value) => !this.validateEndpoint(value).ok);
      if (firstInvalidIndex !== -1) {
        this.saveMessage = `Error: invalid endpoint at position ${firstInvalidIndex + 1}. Only http/https URLs are allowed.`;
        return;
      }

      const defaultSettingsPayload = {};
      for (const setting of normalizedDefaults) {
        defaultSettingsPayload[setting.key] = this.formatSettingValueForKey(setting.key, setting.value);
      }

      const servicesPayload = normalizedServices.map((service) => {
        const settings = {};
        for (const setting of service.settings) {
          settings[setting.key] = this.formatSettingValueForKey(setting.key, setting.value);
        }
        return {
          name: service.name,
          settings,
        };
      });

      this.saving = true;
      this.saveMessage = "";
      this.config.default_settings = normalizedDefaults;
      this.config.services = normalizedServices;
      this.config.upstream_origin_endpoints = normalizedEndpoints;
      try {
        const payload = {
          default_settings: defaultSettingsPayload,
          services: servicesPayload,
          upstream_origin_endpoints: this.config.upstream_origin_endpoints,
        };
        const data = await this.api("/api/config", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        this.saveMessage = `Saved. Backup: ${data.backup}`;
        await this.loadBackups();
      } catch (error) {
        this.saveMessage = `Error: ${String(error.message || error)}`;
      } finally {
        this.saving = false;
      }
    },
    async restoreBackup(name) {
      if (!confirm(`Restore backup ${name}?`)) {
        return;
      }
      try {
        await this.api(`/api/backups/${name}/restore`, { method: "POST" });
        this.saveMessage = `Restored: ${name}`;
        await this.loadConfig();
        await this.loadBackups();
      } catch (error) {
        this.saveMessage = `Restore error: ${String(error.message || error)}`;
      }
    },
    async testUrl() {
      this.testingUrl = true;
      this.testResult = null;
      try {
        this.testResult = await this.api("/api/test-url", {
          method: "POST",
          body: JSON.stringify({
            url: this.testUrlValue,
            timeout_seconds: 20,
          }),
        });
      } catch (error) {
        this.testResult = {
          ok: false,
          status: "ERROR",
          error: String(error.message || error),
          elapsed_ms: 0,
          headers: {},
          body_preview: "",
        };
      } finally {
        this.testingUrl = false;
      }
    },
    openPlayer() {
      const targetUrl = (this.testResult?.final_url || this.testUrlValue || "").trim();
      if (!targetUrl) {
        return;
      }
      try {
        const payload = JSON.stringify({
          src: targetUrl,
          autoplay: true,
          ts: Date.now(),
        });
        globalThis.localStorage.setItem("stitcher_player_request", payload);
      } catch (error) {
        globalThis.console.warn("Unable to persist player request", error);
      }
      globalThis.open(`/player.html?src=${encodeURIComponent(targetUrl)}&autoplay=1`, "_blank", "noopener,noreferrer");
    },
  },
  async mounted() {
    await this.loadStatus();
    await this.loadConfig();
    await this.loadBackups();
    this.loadConfigModal = new globalThis.bootstrap.Modal(this.$refs.loadConfigModal);
    this.pollTimer = globalThis.setInterval(() => {
      if (!document.hidden && !this.loading) {
        this.loadStatus();
      }
    }, 5000);
  },
  unmounted() {
    if (this.loadConfigModal) {
      this.loadConfigModal.dispose();
    }
    if (this.pollTimer) {
      globalThis.clearInterval(this.pollTimer);
    }
  },
  template: `
    <div class="app-shell">
      <nav class="hero-navbar">
        <div class="navbar-inner">
          <span class="nav-brand">
            <i class="bi bi-broadcast-pin me-2"></i>Stitcher Controller
          </span>
          <div class="nav-actions">
            <span class="status-badge" :class="statusBadgeClass">
              <span class="status-dot"></span>
              {{ statusRunning ? 'RUNNING' : 'STOPPED' }}
            </span>
            <button
              v-if="!statusRunning"
              class="btn btn-success btn-sm"
              :disabled="loading"
              @click="runAction('start')"
            >
              <i class="bi bi-play-fill me-1"></i>Start
            </button>
            <button
              v-else
              class="btn btn-danger btn-sm"
              :disabled="loading"
              @click="runAction('stop')"
            >
              <i class="bi bi-stop-fill me-1"></i>Stop
            </button>
            <button
              class="btn btn-warning btn-sm"
              :disabled="loading || !statusRunning"
              @click="runAction('reload')"
            >
              <i class="bi bi-arrow-clockwise me-1"></i>Reload
            </button>
          </div>
        </div>
      </nav>

      <div class="app-body">
        <aside class="sidebar">
          <button
            class="sidebar-btn"
            :class="{ active: activePanel === 'config' }"
            @click="activePanel = 'config'"
            title="Configuration"
          >
            <i class="bi bi-gear-fill"></i>
          </button>
          <button
            class="sidebar-btn"
            :class="{ active: activePanel === 'tester' }"
            @click="activePanel = 'tester'"
            title="URL Tester"
          >
            <i class="bi bi-globe2"></i>
          </button>
          <button
            class="sidebar-btn"
            :class="{ active: activePanel === 'output' }"
            @click="activePanel = 'output'"
            title="Last Output"
          >
            <i class="bi bi-terminal-fill"></i>
          </button>
        </aside>

        <main class="main-content">
          <div v-if="activePanel === 'config'" class="panel-area">
            <div class="row g-3 mb-1">
              <div class="col-12 col-xl-6">
                <div class="card panel-card h-100">
                  <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                      <h6 class="card-title mb-0">Default Settings</h6>
                      <button class="btn btn-primary btn-sm" @click="addDefaultSetting">
                        <i class="bi bi-plus-lg me-1"></i>Add parameter
                      </button>
                    </div>
                    <div class="d-flex flex-column gap-2">
                      <div
                        v-for="(setting, index) in config.default_settings"
                        :key="index"
                        class="setting-inline-row"
                      >
                        <label class="form-label mb-0 small text-muted">Name</label>
                        <input
                          class="form-control form-control-sm"
                          :class="{ 'is-invalid': !defaultSettingValidation[index].ok }"
                          v-model="setting.key"
                          placeholder="parameter_name"
                        />
                        <label class="form-label mb-0 small text-muted">Value</label>
                        <input
                          class="form-control form-control-sm"
                          :class="{ 'is-invalid': !defaultSettingValidation[index].ok }"
                          v-model="setting.value"
                          placeholder="default value"
                        />
                        <button class="btn btn-outline-danger btn-sm" @click="removeDefaultSetting(index)">
                          <i class="bi bi-trash3"></i>
                        </button>
                        <div v-if="!defaultSettingValidation[index].ok" class="invalid-feedback d-block">
                          {{ defaultSettingValidation[index].message }}
                        </div>
                      </div>
                    </div>
                    <div v-if="config.default_settings.length === 0" class="text-muted small mt-1">
                      No default parameter configured.
                    </div>
                  </div>
                </div>
              </div>

              <div class="col-12 col-xl-6">
                <div class="card panel-card h-100">
                  <div class="card-body d-flex flex-column">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                      <h6 class="card-title mb-0">Upstream Origin</h6>
                      <button class="btn btn-primary btn-sm" @click="addEndpoint">
                        <i class="bi bi-plus-lg me-1"></i>Add endpoint
                      </button>
                    </div>
                    <div class="d-flex flex-column gap-2">
                      <div
                        v-for="(endpoint, index) in config.upstream_origin_endpoints"
                        :key="index"
                        class="endpoint-row"
                      >
                        <input
                          class="form-control form-control-sm"
                          :class="{ 'is-invalid': !endpointValidation[index].ok }"
                          v-model="config.upstream_origin_endpoints[index]"
                          placeholder="https://origin.example.com"
                        />
                        <button class="btn btn-outline-danger btn-sm" @click="removeEndpoint(index)">
                          <i class="bi bi-trash3"></i>
                        </button>
                        <div v-if="!endpointValidation[index].ok" class="invalid-feedback d-block">
                          {{ endpointValidation[index].message }}
                        </div>
                      </div>
                    </div>
                    <div v-if="config.upstream_origin_endpoints.length === 0" class="text-muted small mt-1">
                      No upstream endpoint configured.
                    </div>
                    <div v-if="hasInvalidEndpoints" class="text-danger small mt-2">
                      Only valid http/https endpoints can be saved.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Services</h6>
                  <button class="btn btn-primary btn-sm" @click="addService">
                    <i class="bi bi-plus-lg me-1"></i>Add service
                  </button>
                </div>
                <div class="row g-3">
                  <div
                    v-for="(service, index) in config.services"
                    :key="index"
                    class="col-12 col-md-6 col-xl-4"
                  >
                    <div class="card service-grid-card h-100 border-0">
                      <div class="card-body">
                        <div class="service-name-row mb-2">
                          <label class="form-label mb-0 small text-muted">Name</label>
                          <input class="form-control form-control-sm" v-model="service.name" />
                          <button class="btn btn-outline-danger btn-sm" @click="removeService(index)">
                            <i class="bi bi-trash3"></i>
                          </button>
                        </div>
                        <div class="d-flex justify-content-between align-items-center mb-2">
                          <span class="small text-muted">Overrides</span>
                          <button
                            class="btn btn-outline-primary btn-sm"
                            :disabled="defaultSettingKeys.length === 0"
                            @click="addServiceOverride(service)"
                          >
                            <i class="bi bi-plus-lg me-1"></i>Add override
                          </button>
                        </div>
                        <div class="d-flex flex-column gap-2">
                          <div v-for="(override, overrideIndex) in service.settings" :key="overrideIndex" class="service-override-row">
                            <select class="form-select form-select-sm" v-model="override.key">
                              <option
                                v-for="option in overrideOptions(service, override.key)"
                                :key="option"
                                :value="option"
                              >
                                {{ option }}
                              </option>
                            </select>
                            <input class="form-control form-control-sm" v-model="override.value" placeholder="override value" />
                            <button class="btn btn-outline-danger btn-sm" @click="removeServiceOverride(service, overrideIndex)">
                              <i class="bi bi-trash3"></i>
                            </button>
                          </div>
                        </div>
                        <div v-if="service.settings.length === 0" class="text-muted small">
                          No override for this service.
                        </div>
                        <div v-if="!serviceValidation[index].ok" class="text-danger small mt-2">
                          {{ serviceValidation[index].message }}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="config.services.length === 0" class="col-12 text-muted small">No services configured.</div>
                </div>
              </div>
            </div>

            <div class="card panel-card">
              <div class="card-body">
                <h6 class="card-title mb-3">Configuration Files</h6>
                <div class="d-flex flex-nowrap gap-2 mb-3 config-file-actions">
                  <button class="btn btn-primary btn-sm" :disabled="!canSaveConfig" @click="saveConfig">
                    <i class="bi bi-floppy me-1"></i>{{ saving ? 'Saving...' : 'Save Config' }}
                  </button>
                  <button class="btn btn-outline-secondary btn-sm" :disabled="saving" @click="openLoadConfigModal">
                    <i class="bi bi-folder2-open me-1"></i>Load Config
                  </button>
                </div>
                <div v-if="saveMessage" class="alert alert-info py-2 small mb-3">{{ saveMessage }}</div>
              </div>
            </div>
          </div>

          <div v-else-if="activePanel === 'tester'" class="panel-area">
            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
                  <h6 class="card-title mb-0">URL Tester</h6>
                  <span v-if="testResult" class="badge" :class="testStatusClass">{{ testResult.status }}</span>
                </div>
                <div class="input-group mb-3">
                  <input class="form-control" v-model="testUrlValue" placeholder="Enter URL to test" />
                  <button class="btn btn-primary" :disabled="testingUrl || !testUrlValue" @click="testUrl">
                    <i class="bi bi-send me-1"></i>{{ testingUrl ? 'Testing...' : 'Test' }}
                  </button>
                  <button class="btn btn-outline-primary" :disabled="!testUrlValue" @click="openPlayer">
                    <i class="bi bi-play-circle me-1"></i>Player
                  </button>
                </div>
                <div v-if="testResult" class="small">
                  <p class="mb-1"><strong>Elapsed:</strong> {{ testResult.elapsed_ms }} ms</p>
                  <p class="mb-1" v-if="testResult.final_url"><strong>Final URL:</strong> {{ testResult.final_url }}</p>
                  <p class="mb-2 text-danger" v-if="testResult.error"><strong>Error:</strong> {{ testResult.error }}</p>
                  <details>
                    <summary class="mb-1 text-muted">Response headers</summary>
                    <pre class="response-box">{{ JSON.stringify(testResult.headers || {}, null, 2) }}</pre>
                  </details>
                  <details class="mt-2">
                    <summary class="mb-1 text-muted">Response body preview</summary>
                    <pre class="response-box">{{ testResult.body_preview || '(empty body)' }}</pre>
                  </details>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="panel-area">
            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Last Output</h6>
                  <button class="btn btn-outline-secondary btn-sm" :disabled="loading" @click="loadStatus">
                    <i class="bi bi-arrow-clockwise me-1"></i>Refresh
                  </button>
                </div>
                <div v-if="statusOutput" class="output-bar">
                  <pre class="output-bar-pre">{{ statusOutput }}</pre>
                </div>
                <div v-else class="text-muted small">No output available yet.</div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <div class="modal fade" tabindex="-1" ref="loadConfigModal">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Load Configuration</h5>
              <button type="button" class="btn-close" @click="closeLoadConfigModal"></button>
            </div>
            <div class="modal-body">
              <label class="form-label small text-muted mb-1">Configuration file</label>
              <select class="form-select" v-model="selectedLoadTarget">
                <option v-for="target in availableConfigTargets" :key="target.value" :value="target.value">
                  {{ target.label }}
                </option>
              </select>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" @click="closeLoadConfigModal">Cancel</button>
              <button type="button" class="btn btn-primary" @click="loadSelectedConfig">Load</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
}).mount("#app");