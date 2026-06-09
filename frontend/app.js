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
      configReady: true,
      statusOutput: "",
      dockerLogs: "",
      containerStats: null,
      statsHistory: [],
      loadingOutput: false,
      saveMessage: "",
      toasts: [],
      _toastId: 0,
      testUrlValue: "http://localhost:1080/bpk-tv/jumping/dvr30sdefault/index.mpd",
      testResult: null,
      config: {
        default_settings: [],
        services: [],
        upstreams: [],
        vhosts: [],
      },
      backups: [],
      selectedLoadTarget: "current",
      loadConfigModal: null,
      pollTimer: null,
      outputPollTimer: null,
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
    vhostValidation() {
      const names = this.config.vhosts.map((v) => String(v.name ?? "").trim());
      const upstreamNames = this.config.upstreams.map((u) => String(u.name ?? "").trim()).filter(Boolean);
      return this.config.vhosts.map((vhost, index) => {
        const name = names[index];
        if (!name) return { ok: false, message: "Vhost name required" };
        if (names.filter((n) => n === name).length > 1) return { ok: false, message: "Duplicate vhost name" };
        if (!vhost.endpoints || vhost.endpoints.length === 0) return { ok: false, message: "At least one endpoint required" };
        if (!vhost.upstream) return { ok: false, message: "Upstream required" };
        const hasHttps = vhost.endpoints.some((ep) => ep.protocol === "HTTPS");
        if (!hasHttps && vhost.cert_selfsigned) return { ok: false, message: "Certificate only applies with HTTPS endpoint" };
        return { ok: true, message: "" };
      });
    },
    hasInvalidVhosts() {
      return this.vhostValidation.some((item) => !item.ok);
    },
    upstreamValidation() {
      const names = this.config.upstreams.map((u) => String(u.name ?? "").trim());
      return this.config.upstreams.map((upstream, index) => {
        const name = names[index];
        if (!name) return { ok: false, message: "Upstream name required" };
        if (name === "upstream_stitcher") return { ok: false, message: "upstream_stitcher is reserved" };
        if (names.filter((n) => n === name).length > 1) return { ok: false, message: "Duplicate upstream name" };
        if (!upstream.endpoints || upstream.endpoints.length === 0) return { ok: false, message: "At least one endpoint required" };
        const invalidEp = upstream.endpoints.map((ep) => this.validateEndpoint(ep)).find((v) => !v.ok);
        if (invalidEp) return { ok: false, message: "Invalid endpoint: " + invalidEp.message };
        return { ok: true, message: "" };
      });
    },
    hasInvalidUpstreams() {
      return this.upstreamValidation.some((item) => !item.ok);
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
      return !this.saving && !this.hasInvalidUpstreams && !this.hasInvalidDefaultSettings && !this.hasInvalidServices && !this.hasInvalidVhosts;
    },
    availableConfigTargets() {
      const targets = [{ value: "current", label: "Current config file" }];
      for (const backup of this.backups) {
        targets.push({ value: backup, label: backup });
      }
      return targets;
    },
  },
  watch: {
    config: {
      handler(newConfig) {
        // Automatically clear certificate when no HTTPS endpoints
        if (newConfig.vhosts) {
          newConfig.vhosts.forEach((vhost) => {
            const hasHttps = vhost.endpoints && vhost.endpoints.some((ep) => ep.protocol === "HTTPS");
            if (!hasHttps && vhost.cert_selfsigned) {
              vhost.cert_selfsigned = false;
            }
          });
        }
      },
      deep: true,
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
    showToast(message, type = "info") {
      const id = ++this._toastId;
      this.toasts.push({ id, message, type });
      globalThis.setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      }, 4000);
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
      if (globalThis.confirm(`Delete service "${this.config.services[index].name}"?`)) {
        this.config.services.splice(index, 1);
      }
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
    addVhost() {
      const upstreamNames = this.config.upstreams.map((u) => u.name).filter(Boolean);
      this.config.vhosts.push({
        name: "vhost_new",
        var: "vh_new",
        pattern: ".*",
        endpoints: [{ protocol: "HTTP", port: 80 }],
        cert_selfsigned: null,
        cert_file: null,
        upstream: upstreamNames[0] || "",
      });
    },
    removeVhost(index) {
      if (globalThis.confirm(`Delete vhost "${this.config.vhosts[index].name}"?`)) {
        this.config.vhosts.splice(index, 1);
      }
    },
    addVhostEndpoint(vhost) {
      vhost.endpoints.push({ protocol: "HTTP", port: 80 });
    },
    removeVhostEndpoint(vhost, index) {
      vhost.endpoints.splice(index, 1);
    },
    vhostHasHttps(vhost) {
      return (vhost.endpoints || []).some((ep) => ep.protocol === "HTTPS");
    },
    onVhostProtocolChange(vhost, ep) {
      if (ep.protocol === "HTTPS" && ep.port === 80) ep.port = 443;
      if (ep.protocol === "HTTP" && ep.port === 443) ep.port = 80;
      if (!this.vhostHasHttps(vhost)) {
        vhost.cert_selfsigned = null;
        vhost.cert_file = null;
      } else if (vhost.cert_selfsigned === null && vhost.cert_file === null) {
        vhost.cert_selfsigned = "default";
      }
    },
    addUpstream() {
      this.config.upstreams.push({ name: "upstream_new", endpoints: ["https://"] });
    },
    removeUpstream(index) {
      if (globalThis.confirm(`Delete upstream "${this.config.upstreams[index].name}"?`)) {
        this.config.upstreams.splice(index, 1);
      }
    },
    addUpstreamEndpoint(upstream) {
      upstream.endpoints.push("https://");
    },
    removeUpstreamEndpoint(upstream, index) {
      upstream.endpoints.splice(index, 1);
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
    async checkConfigReady() {
      try {
        const data = await this.api("/api/config-ready");
        this.configReady = data.ready;
      } catch (error) {
        console.warn("Could not check config readiness:", error);
        this.configReady = false;
      }
    },
    async loadDockerLogs() {
      try {
        const data = await this.api("/api/docker-logs");
        this.dockerLogs = String(data.logs || "").trim();
      } catch (error) {
        this.dockerLogs = String(error.message || error);
      }
    },
    async loadContainerStats() {
      try {
        this.containerStats = await this.api("/api/container-stats");
        this.pushStatsHistory(this.containerStats);
      } catch (error) {
        this.containerStats = {
          ok: false,
          running: false,
          name: "stitcher",
          cpu: "--",
          memory: "--",
          memory_percent: "--",
          error: String(error.message || error),
        };
      }
    },
    parsePercentValue(value) {
      const normalized = String(value ?? "").replace(",", ".");
      const percentPattern = /-?\d+(?:\.\d+)?/;
      const match = percentPattern.exec(normalized);
      if (!match) {
        return null;
      }
      const parsed = Number(match[0]);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return parsed;
    },
    pushStatsHistory(stats) {
      if (!stats?.ok) {
        return;
      }

      const cpuRaw = this.parsePercentValue(stats.cpu);
      const ramRaw = this.parsePercentValue(stats.memory_percent);
      if (cpuRaw === null || ramRaw === null) {
        return;
      }

      this.statsHistory.push({
        at: new Date().toLocaleTimeString("fr-FR", { hour12: false }),
        cpu: Math.max(0, Math.min(cpuRaw, 100)),
        ram: Math.max(0, Math.min(ramRaw, 100)),
        cpuRaw,
        ramRaw,
      });

      const maxPoints = 24;
      if (this.statsHistory.length > maxPoints) {
        this.statsHistory.splice(0, this.statsHistory.length - maxPoints);
      }
    },
    async refreshOutputPanel() {
      this.loadingOutput = true;
      try {
        await Promise.all([this.loadStatus(), this.loadDockerLogs(), this.loadContainerStats()]);
      } finally {
        this.loadingOutput = false;
      }
    },
    async runAction(action) {
      this.loading = true;
      const labels = { start: "Starting Stitcher", stop: "Stopping Stitcher", reload: "Reloading configuration", restart: "Restarting Stitcher", init: "Initializing Stitcher" };
      this.showToast(labels[action] || action, "info");
      try {
        const data = await this.api(`/api/control/${action}`, { method: "POST" });
        this.statusRunning = data.running;
        this.statusOutput = `${data.result.stdout || ""}${data.result.stderr || ""}`.trim();
        this.showToast(`${action} complete`, "success");
        if (action === "init") {
          this.configReady = true;
        }
      } catch (error) {
        this.statusOutput = String(error.message || error);
        this.showToast(`Error: ${String(error.message || error).slice(0, 80)}`, "danger");
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

      this.config.upstreams = (data.upstreams || []).map((u) => ({
        name: u.name,
        endpoints: Array.isArray(u.endpoints) ? [...u.endpoints] : [],
      }));

      this.config.vhosts = (data.vhosts || []).map((v) => ({
        name: v.name,
        var: v.var || "",
        pattern: v.pattern || ".*",
        endpoints: (v.endpoints || []).map((ep) => ({ protocol: ep.protocol, port: ep.port })),
        cert_selfsigned: v.cert_selfsigned ?? null,
        cert_file: v.cert_file ?? null,
        upstream: v.upstream || "",
      }));
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
          this.showToast("Configuration loaded.", "success");
        } else {
          await this.api(`/api/backups/${this.selectedLoadTarget}/restore`, { method: "POST" });
          await this.loadConfig();
          await this.loadBackups();
          this.saveMessage = `Loaded: ${this.selectedLoadTarget}`;
          this.showToast(`Loaded: ${this.selectedLoadTarget}`, "success");
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

      const firstInvalidUpstream = this.upstreamValidation.findIndex((item) => !item.ok);
      if (firstInvalidUpstream !== -1) {
        this.saveMessage = `Error: invalid upstream at position ${firstInvalidUpstream + 1}.`;
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

      const upstreamsPayload = this.config.upstreams.map((u) => ({
        name: String(u.name ?? "").trim(),
        endpoints: (u.endpoints || []).map((ep) => String(ep ?? "").trim()).filter(Boolean),
      }));

      const vhostsPayload = this.config.vhosts.map((v) => ({
        name: String(v.name ?? "").trim(),
        var: String(v.var ?? "").trim() || v.name.replace(/[^a-z0-9]/g, "_"),
        pattern: String(v.pattern ?? ".*").trim(),
        endpoints: (v.endpoints || []).map((ep) => ({ protocol: ep.protocol, port: Number(ep.port) })),
        cert_selfsigned: v.cert_selfsigned || null,
        cert_file: v.cert_file || null,
        upstream: String(v.upstream ?? "").trim(),
      }));

      this.saving = true;
      this.saveMessage = "";
      this.config.default_settings = normalizedDefaults;
      this.config.services = normalizedServices;
      try {
        const payload = {
          default_settings: defaultSettingsPayload,
          services: servicesPayload,
          upstreams: upstreamsPayload,
          vhosts: vhostsPayload,
        };
        const data = await this.api("/api/config", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        this.saveMessage = `Saved. Backup: ${data.backup}`;
        this.showToast(`Saved. Backup: ${data.backup}`, "success");
        await this.loadBackups();
      } catch (error) {
        this.saveMessage = `Error: ${String(error.message || error)}`;
        this.showToast(`Save error: ${String(error.message || error).slice(0, 80)}`, "danger");
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
        this.showToast(`Restored: ${name}`, "success");
        await this.loadConfig();
        await this.loadBackups();
      } catch (error) {
        this.saveMessage = `Restore error: ${String(error.message || error)}`;
        this.showToast(`Restore error: ${String(error.message || error).slice(0, 80)}`, "danger");
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
    await this.checkConfigReady();
    await this.loadStatus();
    await this.loadDockerLogs();
    await this.loadContainerStats();
    await this.loadConfig();
    await this.loadBackups();
    this.loadConfigModal = new globalThis.bootstrap.Modal(this.$refs.loadConfigModal);
    this.pollTimer = globalThis.setInterval(() => {
      if (!document.hidden && !this.loading) {
        this.loadStatus();
      }
    }, 5000);
    this.outputPollTimer = globalThis.setInterval(() => {
      if (!document.hidden && !this.loadingOutput) {
        this.refreshOutputPanel();
      }
    }, 10000);
  },
  unmounted() {
    if (this.loadConfigModal) {
      this.loadConfigModal.dispose();
    }
    if (this.pollTimer) {
      globalThis.clearInterval(this.pollTimer);
    }
    if (this.outputPollTimer) {
      globalThis.clearInterval(this.outputPollTimer);
    }
  },
  template: `
    <div class="app-shell">
      <nav class="hero-navbar">
        <div class="navbar-inner">
          <span class="nav-brand">
            <i class="bi bi-broadcast-pin me-2"></i>Stitcher Controller
          </span>
          <div class="nav-status">
            <span class="status-badge" :class="loading ? 'badge-processing' : statusBadgeClass">
              <span v-if="!loading" class="status-dot"></span>
              <span v-if="loading" class="processing-content">
                <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                <span>PROCESSING</span>
              </span>
              <span v-else>
                {{ statusRunning ? 'RUNNING' : 'STOPPED' }}
              </span>
            </span>
          </div>
          <div class="nav-actions">
            <button
              v-if="!configReady"
              class="btn btn-primary btn-sm"
              :disabled="loading"
              @click="runAction('init')"
            >
              <i class="bi bi-gear-fill me-1"></i>Init
            </button>
            <button
              v-else-if="!statusRunning"
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
              class="btn btn-primary btn-sm"
              :disabled="!canSaveConfig"
              @click="saveConfig"
            >
              <i class="bi bi-floppy me-1"></i>{{ saving ? 'Saving...' : 'Save' }}
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="saving"
              @click="openLoadConfigModal"
            >
              <i class="bi bi-folder2-open me-1"></i>Load
            </button>
            <button
              class="btn btn-primary btn-sm"
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
            title="Output"
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

            </div>

            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Upstreams</h6>
                  <button class="btn btn-primary btn-sm" @click="addUpstream">
                    <i class="bi bi-plus-lg me-1"></i>Add upstream
                  </button>
                </div>
                <div class="row g-3">
                  <div
                    v-for="(upstream, uIdx) in config.upstreams"
                    :key="uIdx"
                    class="col-12 col-md-6 col-xl-4"
                  >
                    <div class="card service-grid-card h-100 border-0">
                      <div class="card-body">
                        <div class="service-name-row mb-2">
                          <label class="form-label mb-0 small text-muted">Name</label>
                          <input
                            class="form-control form-control-sm"
                            :class="{ 'is-invalid': !upstreamValidation[uIdx].ok }"
                            v-model="upstream.name"
                            placeholder="upstream_origin"
                          />
                          <button class="btn btn-outline-danger btn-sm" @click="removeUpstream(uIdx)">
                            <i class="bi bi-trash3"></i>
                          </button>
                        </div>
                        <div v-if="!upstreamValidation[uIdx].ok" class="text-danger small mb-2">
                          {{ upstreamValidation[uIdx].message }}
                        </div>
                        <div class="d-flex justify-content-between align-items-center mb-2">
                          <span class="small text-muted">Endpoints</span>
                          <button class="btn btn-outline-primary btn-sm" @click="addUpstreamEndpoint(upstream)">
                            <i class="bi bi-plus-lg me-1"></i>Add
                          </button>
                        </div>
                        <div class="d-flex flex-column gap-1">
                          <div
                            v-for="(ep, epIdx) in upstream.endpoints"
                            :key="epIdx"
                            class="endpoint-row"
                          >
                            <input
                              class="form-control form-control-sm"
                              :class="{ 'is-invalid': !validateEndpoint(ep).ok }"
                              v-model="upstream.endpoints[epIdx]"
                              placeholder="https://origin.example.com"
                            />
                            <button class="btn btn-outline-danger btn-sm" @click="removeUpstreamEndpoint(upstream, epIdx)">
                              <i class="bi bi-trash3"></i>
                            </button>
                            <div v-if="!validateEndpoint(ep).ok" class="invalid-feedback d-block">
                              {{ validateEndpoint(ep).message }}
                            </div>
                          </div>
                        </div>
                        <div v-if="!upstream.endpoints || upstream.endpoints.length === 0" class="text-muted small mt-1">
                          No endpoint configured.
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="config.upstreams.length === 0" class="col-12 text-muted small">No upstreams configured.</div>
                </div>
              </div>
            </div>

            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Virtual Hosts</h6>
                  <button class="btn btn-primary btn-sm" @click="addVhost">
                    <i class="bi bi-plus-lg me-1"></i>Add vhost
                  </button>
                </div>
                <div class="row g-3">
                  <div
                    v-for="(vhost, vIdx) in config.vhosts"
                    :key="vIdx"
                    class="col-12 col-md-6 col-xl-4"
                  >
                    <div class="card service-grid-card h-100 border-0">
                      <div class="card-body">
                        <div class="service-name-row mb-2">
                          <label class="form-label mb-0 small text-muted">Name</label>
                          <input
                            class="form-control form-control-sm"
                            :class="{ 'is-invalid': !vhostValidation[vIdx].ok }"
                            v-model="vhost.name"
                            placeholder="vhost_streaming"
                          />
                          <button class="btn btn-outline-danger btn-sm" @click="removeVhost(vIdx)">
                            <i class="bi bi-trash3"></i>
                          </button>
                        </div>
                        <div v-if="!vhostValidation[vIdx].ok" class="text-danger small mb-2">
                          {{ vhostValidation[vIdx].message }}
                        </div>

                        <div class="row g-2 mb-2">
                          <div class="col-6">
                            <label class="form-label mb-1 small text-muted">Pattern (regex)</label>
                            <input class="form-control form-control-sm" v-model="vhost.pattern" placeholder=".*" />
                          </div>
                          <div class="col-6">
                            <label class="form-label mb-1 small text-muted">Upstream</label>
                            <select class="form-select form-select-sm" v-model="vhost.upstream">
                              <option value="">-- select --</option>
                              <option v-for="u in config.upstreams" :key="u.name" :value="u.name">{{ u.name }}</option>
                            </select>
                          </div>
                        </div>

                        <div class="d-flex justify-content-between align-items-center mb-2">
                          <span class="small text-muted">Endpoints</span>
                          <button class="btn btn-outline-primary btn-sm" @click="addVhostEndpoint(vhost)">
                            <i class="bi bi-plus-lg me-1"></i>Add
                          </button>
                        </div>
                        <div class="d-flex flex-wrap gap-1 mb-2">
                          <div v-for="(ep, epIdx) in vhost.endpoints" :key="epIdx" class="d-flex gap-1 align-items-center">
                            <select
                              class="form-select form-select-sm"
                              style="width:90px;flex-shrink:0"
                              v-model="ep.protocol"
                              @change="onVhostProtocolChange(vhost, ep)"
                            >
                              <option>HTTP</option>
                              <option>HTTPS</option>
                            </select>
                            <input
                              class="form-control form-control-sm"
                              type="number"
                              min="1"
                              max="65535"
                              v-model.number="ep.port"
                              style="width:80px;flex-shrink:0"
                            />
                            <button class="btn btn-outline-danger btn-sm" @click="removeVhostEndpoint(vhost, epIdx)">
                              <i class="bi bi-trash3"></i>
                            </button>
                          </div>
                        </div>

                        <div v-if="vhostHasHttps(vhost)">
                          <label class="form-label mb-1 small text-muted">Certificate</label>
                          <div class="d-flex gap-2 mb-1">
                            <div class="form-check form-check-inline">
                              <input
                                class="form-check-input"
                                type="radio"
                                :name="'cert-mode-' + vIdx"
                                :id="'cert-self-' + vIdx"
                                :value="true"
                                :checked="!vhost.cert_file"
                                @change="vhost.cert_file = null; vhost.cert_selfsigned = vhost.cert_selfsigned || 'default'"
                              />
                              <label class="form-check-label small" :for="'cert-self-' + vIdx">Self-signed</label>
                            </div>
                            <div class="form-check form-check-inline">
                              <input
                                class="form-check-input"
                                type="radio"
                                :name="'cert-mode-' + vIdx"
                                :id="'cert-file-' + vIdx"
                                :value="false"
                                :checked="!!vhost.cert_file"
                                @change="vhost.cert_selfsigned = null; vhost.cert_file = vhost.cert_file || ''"
                              />
                              <label class="form-check-label small" :for="'cert-file-' + vIdx">Custom</label>
                            </div>
                          </div>
                          <input
                            v-if="!vhost.cert_file && vhost.cert_file !== ''"
                            class="form-control form-control-sm"
                            v-model="vhost.cert_selfsigned"
                            placeholder="default"
                          />
                          <input
                            v-else
                            class="form-control form-control-sm"
                            v-model="vhost.cert_file"
                            placeholder='read_file("/etc/...cert"), read_file("/etc/...key")'
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="config.vhosts.length === 0" class="col-12 text-muted small">No virtual hosts configured.</div>
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
                          <span class="small text-muted">Default Settings Overrides</span>
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
                <div class="mb-3">
                  <div class="small text-muted mb-1">Container Resources</div>
                  <div class="stats-grid" v-if="containerStats">
                    <div class="stats-tile">
                      <div class="stats-label">Container</div>
                      <div class="stats-value">{{ containerStats.name || 'stitcher' }}</div>
                    </div>
                    <div class="stats-tile">
                      <div class="stats-label">CPU</div>
                      <div class="stats-value">{{ containerStats.cpu || '--' }}</div>
                    </div>
                    <div class="stats-tile">
                      <div class="stats-label">RAM</div>
                      <div class="stats-value">{{ containerStats.memory || '--' }}</div>
                    </div>
                    <div class="stats-tile">
                      <div class="stats-label">RAM %</div>
                      <div class="stats-value">{{ containerStats.memory_percent || '--' }}</div>
                    </div>
                  </div>
                  <div v-if="containerStats && containerStats.error" class="text-muted small mt-2">
                    {{ containerStats.error }}
                  </div>
                </div>
                <div class="mb-3">
                  <div class="small text-muted mb-1">Docker Output</div>
                  <div v-if="statusOutput" class="output-bar">
                    <pre class="output-bar-pre">{{ statusOutput }}</pre>
                  </div>
                  <div v-else class="text-muted small">No docker output available yet.</div>
                </div>
                <div>
                  <div class="small text-muted mb-1">Docker Logs</div>
                  <div v-if="dockerLogs" class="output-bar output-bar-large">
                    <pre class="output-bar-pre output-bar-pre-large">{{ dockerLogs }}</pre>
                  </div>
                  <div v-else class="text-muted small">No docker logs available yet.</div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <div class="app-footer">
        <transition-group name="toast" tag="div" class="toast-stack">
          <div
            v-for="toast in toasts"
            :key="toast.id"
            class="toast-item"
            :class="{ 'toast-success': toast.type === 'success', 'toast-danger': toast.type === 'danger', 'toast-info': toast.type === 'info' }"
          >
            <i class="bi me-2" :class="{ 'bi-check-circle-fill': toast.type === 'success', 'bi-exclamation-triangle-fill': toast.type === 'danger', 'bi-info-circle-fill': toast.type === 'info' }"></i>
            {{ toast.message }}
          </div>
        </transition-group>
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