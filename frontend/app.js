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
      originTraffic: [],
      originTrafficSummary: {
        before_request: 0,
        after_reply: 0,
        manifest: 0,
      },
      loadingTraffic: false,
      trafficError: "",
      trafficHostFilter: "",
      trafficTail: 1200,
      trafficManifestOnly: false,
      containerStats: null,
      statsHistory: [],
      loadingOutput: false,
      saveMessage: "",
      toasts: [],
      _toastId: 0,
      testUrlValue: "http://192.9.80.52:1080/bpk-tv/ARTE/default/index.mpd",
      testResult: null,
      rawConfigText: "",
      config: {
        default_settings: [],
        monitoring_enabled: false,
        prometheus_port: 11450,
        services: [],
        upstreams: [],
        vhosts: [],
      },
      backups: [],
      selectedLoadTarget: "current",
      loadConfigModal: null,
      pollTimer: null,
      outputPollTimer: null,
      configModified: false,
      needsReload: false,
      isLoading: false,
      loadingConfig: false,
      navBusyLabel: "",
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
    prometheusPortValidation() {
      const value = Number(this.config.prometheus_port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return {
          ok: false,
          message: "Prometheus port must be an integer between 1 and 65535",
        };
      }
      return { ok: true, message: "" };
    },
    hasInvalidMonitoring() {
      return !this.prometheusPortValidation.ok;
    },
    defaultSettingKeys() {
      return this.config.default_settings
        .map((setting) => String(setting.key ?? "").trim())
        .filter((key, index, source) => key && source.indexOf(key) === index);
    },
    defaultSettingUiByKey() {
      const result = {};
      for (const setting of this.config.default_settings) {
        const key = String(setting.key ?? "").trim();
        if (!key) {
          continue;
        }
        result[key] = {
          label: String(setting.label ?? "").trim(),
          tooltip: String(setting.tooltip ?? "").trim(),
        };
      }
      return result;
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
      return !this.saving
        && !this.hasInvalidUpstreams
        && !this.hasInvalidDefaultSettings
        && !this.hasInvalidMonitoring
        && !this.hasInvalidServices
        && !this.hasInvalidVhosts;
    },
    availableConfigTargets() {
      const targets = [{ value: "current", label: "Current config file" }];
      for (const backup of this.backups) {
        targets.push({ value: backup, label: backup });
      }
      return targets;
    },
    isNavBusy() {
      return this.loading || this.saving || this.testingUrl || this.loadingConfig || this.isLoading;
    },
    navBusyText() {
      return this.navBusyLabel || "PROCESSING";
    },
  },
  watch: {
    config: {
      handler(newConfig) {
        // Don't mark as modified during loading
        if (this.isLoading) return;
        
        // Automatically clear certificate when no HTTPS endpoints
        if (newConfig.vhosts) {
          newConfig.vhosts.forEach((vhost) => {
            const hasHttps = vhost.endpoints?.some((ep) => ep.protocol === "HTTPS");
            if (!hasHttps && vhost.cert_selfsigned) {
              vhost.cert_selfsigned = false;
            }
          });
        }
        // Mark config as modified
        this.configModified = true;
      },
      deep: true,
      flush: 'sync',
    },
    activePanel(newPanel) {
      this.initializeTooltips();
      this.initializeCodeHighlight();
      if (newPanel === "traffic" && this.originTraffic.length === 0 && !this.loadingTraffic) {
        this.loadOriginTraffic();
      }
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
        label: "",
        tooltip: "",
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
    defaultSettingDisplayName(key) {
      const normalizedKey = String(key ?? "").trim();
      if (!normalizedKey) {
        return "";
      }
      const meta = this.defaultSettingUiByKey[normalizedKey] || {};
      return meta.label || normalizedKey;
    },
    defaultSettingTooltip(key) {
      const normalizedKey = String(key ?? "").trim();
      if (!normalizedKey) {
        return "";
      }
      const meta = this.defaultSettingUiByKey[normalizedKey] || {};
      return meta.tooltip || "";
    },
    addVhost() {
      const firstUpstream = this.config.upstreams.find((u) => u.name);
      this.config.vhosts.push({
        name: "vhost_new",
        var: "vh_new",
        pattern: ".*",
        endpoints: [{ protocol: "HTTP", port: 80 }],
        cert_selfsigned: null,
        cert_file: null,
        upstream: firstUpstream?.name || "",
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
    async loadOriginTraffic() {
      this.loadingTraffic = true;
      this.trafficError = "";
      try {
        const params = new URLSearchParams();
        params.set("tail", String(this.trafficTail || 1200));
        if (this.trafficHostFilter.trim()) {
          params.set("origin_host", this.trafficHostFilter.trim());
        }
        params.set("manifest_only", this.trafficManifestOnly ? "true" : "false");
        const data = await this.api(`/api/origin-traffic?${params.toString()}`);
        this.originTraffic = Array.isArray(data.events) ? data.events : [];
        this.originTrafficSummary = data.summary || {
          before_request: 0,
          after_reply: 0,
          manifest: 0,
        };
      } catch (error) {
        this.trafficError = String(error.message || error);
        this.originTraffic = [];
      } finally {
        this.loadingTraffic = false;
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
      const busyLabels = { start: "STARTING", stop: "STOPPING", reload: "RELOADING", restart: "RESTARTING", init: "INITIALIZING" };
      this.navBusyLabel = busyLabels[action] || "PROCESSING";
      this.showToast(labels[action] || action, "info");
      try {
        const data = await this.api(`/api/control/${action}`, { method: "POST" });
        this.statusRunning = data.running;
        this.statusOutput = `${data.result.stdout || ""}${data.result.stderr || ""}`.trim();
        this.showToast(`${action} complete`, "success");
        if (action === "init") {
          this.configReady = true;
        }
        if (action === "reload") {
          this.needsReload = false;
        }
      } catch (error) {
        this.statusOutput = String(error.message || error);
        this.showToast(`Error: ${String(error.message || error).slice(0, 80)}`, "danger");
      } finally {
        this.loading = false;
        this.navBusyLabel = "";
      }
    },
    normalizeConfig(data) {
      const defaults = data.default_settings || {};
      const defaultsMeta = data.default_settings_meta || {};
      this.config.default_settings = Object.entries(defaults).map(([key, value]) => ({
        key,
        value: String(key).startsWith("param_") ? this.stripOuterQuotes(value) : String(value ?? ""),
        label: String(defaultsMeta[key]?.label ?? ""),
        tooltip: String(defaultsMeta[key]?.tooltip ?? ""),
      }));

      this.config.monitoring_enabled = Boolean(data.monitoring_enabled);
      this.config.prometheus_port = Number.isInteger(Number(data.prometheus_port))
        ? Number(data.prometheus_port)
        : 11450;

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
    initializeTooltips() {
      this.$nextTick(() => {
        const tooltipElements = document.querySelectorAll('[data-bs-toggle="tooltip"]');
        tooltipElements.forEach((el) => {
          const instance = globalThis.bootstrap.Tooltip.getInstance(el);
          if (instance) {
            instance.dispose();
          }
          // eslint-disable-next-line no-unused-vars
          const _ = globalThis.bootstrap.Tooltip.getOrCreateInstance(el);
        });
      });
    },
    initializeCodeHighlight() {
      this.$nextTick(() => {
        if (!globalThis.hljs) {
          return;
        }
        document.querySelectorAll(".config-source-pre code").forEach((el) => {
          el.innerHTML = el.textContent;
          delete el.dataset.highlighted;
          el.classList.remove("hljs");
          globalThis.hljs.highlightElement(el);
        });
      });
    },
    async loadConfig() {
      const setLoadingLabel = !this.navBusyLabel;
      if (setLoadingLabel) {
        this.navBusyLabel = "LOADING";
      }
      this.isLoading = true;
      try {
        const data = await this.api("/api/config");
        this.normalizeConfig(data);
        this.rawConfigText = String(data.raw || "");
        this.configModified = false;
        this.needsReload = false;
        this.initializeTooltips();
        this.initializeCodeHighlight();
      } finally {
        this.isLoading = false;
        if (setLoadingLabel && this.navBusyLabel === "LOADING") {
          this.navBusyLabel = "";
        }
      }
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
      this.loadingConfig = true;
      this.navBusyLabel = "LOADING";
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
      } finally {
        this.loadingConfig = false;
        this.navBusyLabel = "";
      }
    },
    async saveConfig() {
      const normalizedDefaults = this.config.default_settings.map((setting) => ({
        key: String(setting.key ?? "").trim(),
        value: String(setting.value ?? "").trim(),
        label: String(setting.label ?? "").trim(),
        tooltip: String(setting.tooltip ?? "").trim(),
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
      const defaultSettingsMetaPayload = {};
      for (const setting of normalizedDefaults) {
        defaultSettingsPayload[setting.key] = this.formatSettingValueForKey(setting.key, setting.value);
        if (setting.label || setting.tooltip) {
          defaultSettingsMetaPayload[setting.key] = {
            label: setting.label,
            tooltip: setting.tooltip,
          };
        }
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
      this.navBusyLabel = "SAVING";
      this.saveMessage = "";
      this.config.default_settings = normalizedDefaults;
      this.config.services = normalizedServices;
      try {
        const payload = {
          default_settings: defaultSettingsPayload,
          default_settings_meta: defaultSettingsMetaPayload,
          monitoring_enabled: Boolean(this.config.monitoring_enabled),
          prometheus_port: Number(this.config.prometheus_port),
          services: servicesPayload,
          upstreams: upstreamsPayload,
          vhosts: vhostsPayload,
        };
        const data = await this.api("/api/config", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        await this.loadConfig();
        this.configModified = false;
        this.needsReload = true;
        await this.loadBackups();
        this.saveMessage = `Saved. Backup: ${data.backup}`;
        this.showToast(`Saved. Backup: ${data.backup}`, "success");
      } catch (error) {
        this.saveMessage = `Error: ${String(error.message || error)}`;
        this.showToast(`Save error: ${String(error.message || error).slice(0, 80)}`, "danger");
      } finally {
        this.saving = false;
        this.navBusyLabel = "";
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
      this.navBusyLabel = "TESTING";
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
        this.navBusyLabel = "";
      }
    },
    openPlayer() {
      const targetUrl = (this.testResult?.final_url || this.testUrlValue || "").trim();
      if (!targetUrl) {
        return;
      }
      globalThis.open(`http://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html?autoplay=true&stream=${encodeURIComponent(targetUrl)}`, "_blank", "noopener,noreferrer");
    },
  },
  async mounted() {
    await this.checkConfigReady();
    await this.loadStatus();
    await this.loadDockerLogs();
    await this.loadContainerStats();
    await this.loadOriginTraffic();
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
        if (this.activePanel === "output") {
          this.refreshOutputPanel();
        } else if (this.activePanel === "traffic" && !this.loadingTraffic) {
          this.loadOriginTraffic();
        }
      }
    }, 10000);
    this.initializeTooltips();
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
            <img class="nav-brand-logo" src="/assets/stitcher.svg" alt="Stitcher logo" />
            <span>Stitcher Controller</span>
          </span>
          <div class="nav-status">
            <span class="status-badge" :class="isNavBusy ? 'badge-processing' : statusBadgeClass">
              <span v-if="!isNavBusy" class="status-dot"></span>
              <span v-if="isNavBusy" class="processing-content">
                <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                <span>{{ navBusyText }}</span>
              </span>
              <span v-else>
                {{ statusRunning ? 'RUNNING' : 'STOPPED' }}
              </span>
            </span>
          </div>
          <div class="nav-actions">
            <button
              v-if="!configReady"
              class="btn btn-secondary btn-sm"
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
              class="btn btn-secondary btn-sm"
              :class="{ 'btn-pulsing': configModified }"
              :disabled="!canSaveConfig"
              @click="saveConfig"
            >
              <i class="bi bi-floppy me-1"></i>Save
            </button>
            <button
              class="btn btn-secondary btn-sm"
              :disabled="saving"
              @click="openLoadConfigModal"
            >
              <i class="bi bi-folder2-open me-1"></i>Load
            </button>
            <button
              class="btn btn-secondary btn-sm position-relative"
              :class="{ 'btn-info': needsReload }"
              :disabled="loading || !statusRunning"
              @click="runAction('reload')"
            >
              <i class="bi bi-arrow-clockwise me-1"></i>Reload
              <span v-if="needsReload" class="position-absolute top-0 start-100 translate-middle bg-info rounded-circle" style="width: 0.375rem; height: 0.375rem;"></span>
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
            :class="{ active: activePanel === 'defaults' }"
            @click="activePanel = 'defaults'"
            title="Default Settings"
          >
            <i class="bi bi-sliders"></i>
          </button>
          <button
            class="sidebar-btn"
            :class="{ active: activePanel === 'config-source' }"
            @click="activePanel = 'config-source'"
            title="Configuration File"
          >
            <i class="bi bi-file-earmark-code"></i>
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
          <button
            class="sidebar-btn"
            :class="{ active: activePanel === 'traffic' }"
            @click="activePanel = 'traffic'"
            title="Origin Traffic"
          >
            <i class="bi bi-activity"></i>
          </button>
        </aside>

        <main class="main-content">
          <div v-if="activePanel === 'defaults'" class="panel-area">
            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Default Settings</h6>
                  <button class="btn btn-outline-primary btn-sm" @click="addDefaultSetting">
                    <i class="bi bi-plus-lg me-1"></i>Add parameter
                  </button>
                </div>
                <div class="default-settings-head small text-muted mb-2">
                  <span data-bs-toggle="tooltip" data-bs-title="Internal parameter name used in configuration" data-bs-delay='{"show": 500, "hide": 100}'>Parameter</span>
                  <span data-bs-toggle="tooltip" data-bs-title="Default value if parameter not overridden in services" data-bs-delay='{"show": 500, "hide": 100}'>Default value</span>
                  <span data-bs-toggle="tooltip" data-bs-title="Human-readable label shown in the UI" data-bs-delay='{"show": 500, "hide": 100}'>Display name</span>
                  <span data-bs-toggle="tooltip" data-bs-title="Tooltip text shown when hovering over the parameter" data-bs-delay='{"show": 500, "hide": 100}'>Tooltip</span>
                  <span></span>
                </div>
                <div class="d-flex flex-column gap-2">
                  <div
                    v-for="(setting, index) in config.default_settings"
                    :key="index"
                    class="default-setting-row"
                  >
                    <input
                      class="form-control form-control-sm"
                      :class="{ 'is-invalid': !defaultSettingValidation[index].ok }"
                      v-model="setting.key"
                      placeholder="parameter_name"
                    />
                    <input
                      class="form-control form-control-sm"
                      :class="{ 'is-invalid': !defaultSettingValidation[index].ok }"
                      v-model="setting.value"
                      placeholder="default value"
                    />
                    <input
                      class="form-control form-control-sm"
                      v-model="setting.label"
                      placeholder="Friendly name in Configuration"
                    />
                    <input
                      class="form-control form-control-sm"
                      v-model="setting.tooltip"
                      placeholder="Tooltip shown in Configuration"
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

            <div class="card panel-card">
              <div class="card-body">
                <h6 class="card-title mb-3">Monitoring</h6>
                <div class="monitoring-box">
                  <div class="monitoring-grid">
                    <div>
                      <div class="small text-muted mb-1">Monitoring state</div>
                      <div class="form-check form-check-inline">
                        <input
                          class="form-check-input"
                          type="radio"
                          name="monitoring-enabled"
                          id="monitoring-on"
                          :value="true"
                          v-model="config.monitoring_enabled"
                        />
                        <label class="form-check-label" for="monitoring-on">On</label>
                      </div>
                      <div class="form-check form-check-inline">
                        <input
                          class="form-check-input"
                          type="radio"
                          name="monitoring-enabled"
                          id="monitoring-off"
                          :value="false"
                          v-model="config.monitoring_enabled"
                        />
                        <label class="form-check-label" for="monitoring-off">Off</label>
                      </div>
                    </div>
                    <div>
                      <label class="form-label mb-1 small text-muted" for="prometheus-port">Prometheus port</label>
                      <input
                        id="prometheus-port"
                        class="form-control form-control-sm"
                        :class="{ 'is-invalid': !prometheusPortValidation.ok }"
                        type="number"
                        min="1"
                        max="65535"
                        step="1"
                        v-model.number="config.prometheus_port"
                        placeholder="11450"
                      />
                      <div v-if="!prometheusPortValidation.ok" class="invalid-feedback d-block">
                        {{ prometheusPortValidation.message }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="activePanel === 'config-source'" class="panel-area panel-area-config-source">
            <div class="card panel-card panel-card-config-source">
              <div class="card-body card-body-config-source">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">stitcher.conf.cc</h6>
                  <span class="small text-muted">Formatted source view</span>
                </div>
                <div class="config-source-shell">
                  <pre class="config-source-pre"><code class="language-cpp">{{ rawConfigText }}</code></pre>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="activePanel === 'config'" class="panel-area">
            <div class="card panel-card">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Services</h6>
                  <button class="btn btn-outline-primary btn-sm" @click="addService">
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
                          <label class="form-label mb-0 small text-muted" data-bs-toggle="tooltip" data-bs-title="Unique service identifier" data-bs-delay='{"show": 500, "hide": 100}'>Name</label>
                          <input class="form-control form-control-sm" v-model="service.name" data-bs-toggle="tooltip" data-bs-title="Service name used in configuration" data-bs-delay='{"show": 500, "hide": 100}' />
                          <button class="btn btn-outline-danger btn-sm" @click="removeService(index)">
                            <i class="bi bi-trash3"></i>
                          </button>
                        </div>
                        <div class="d-flex justify-content-between align-items-center mb-2">
                          <span class="small text-muted" data-bs-toggle="tooltip" data-bs-title="Override default settings for this service" data-bs-delay='{"show": 500, "hide": 100}'>Default Settings Overrides</span>
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
                            <select
                              class="form-select form-select-sm"
                              v-model="override.key"
                              data-bs-toggle="tooltip"
                              :data-bs-title="defaultSettingTooltip(override.key) || ''"
                              data-bs-delay='{"show": 500, "hide": 100}'
                            >
                              <option
                                v-for="option in overrideOptions(service, override.key)"
                                :key="option"
                                :value="option"
                              >
                                {{ defaultSettingDisplayName(option) }}
                              </option>
                            </select>
                            <input
                              class="form-control form-control-sm"
                              v-model="override.value"
                              placeholder="override value"
                              data-bs-toggle="tooltip"
                              :data-bs-title="defaultSettingTooltip(override.key) || ''"
                              data-bs-delay='{"show": 500, "hide": 100}'
                            />
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
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h6 class="card-title mb-0">Upstreams</h6>
                  <button class="btn btn-outline-primary btn-sm" @click="addUpstream">
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
                          <label class="form-label mb-0 small text-muted" data-bs-toggle="tooltip" data-bs-title="Unique upstream origin identifier" data-bs-delay='{"show": 500, "hide": 100}'>Name</label>
                          <input
                            class="form-control form-control-sm"
                            :class="{ 'is-invalid': !upstreamValidation[uIdx].ok }"
                            v-model="upstream.name"
                            placeholder="upstream_origin"
                            data-bs-toggle="tooltip"
                            data-bs-title="Origin/upstream name used in virtual host routing"
                            data-bs-delay='{"show": 500, "hide": 100}'
                          />
                          <button class="btn btn-outline-danger btn-sm" @click="removeUpstream(uIdx)">
                            <i class="bi bi-trash3"></i>
                          </button>
                        </div>
                        <div v-if="!upstreamValidation[uIdx].ok" class="text-danger small mb-2">
                          {{ upstreamValidation[uIdx].message }}
                        </div>
                        <div class="d-flex justify-content-between align-items-center mb-2">
                          <span class="small text-muted" data-bs-toggle="tooltip" data-bs-title="Backend server URLs" data-bs-delay='{"show": 500, "hide": 100}'>Endpoints</span>
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
                              data-bs-toggle="tooltip"
                              data-bs-title="Full URL of the upstream server (e.g., https://origin.example.com:8080)"
                              data-bs-delay='{"show": 500, "hide": 100}'
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
                  <button class="btn btn-outline-primary btn-sm" @click="addVhost">
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
                          <label class="form-label mb-0 small text-muted" data-bs-toggle="tooltip" data-bs-title="Unique virtual host identifier" data-bs-delay='{"show": 500, "hide": 100}'>Name</label>
                          <input
                            class="form-control form-control-sm"
                            :class="{ 'is-invalid': !vhostValidation[vIdx].ok }"
                            v-model="vhost.name"
                            placeholder="vhost_streaming"
                            data-bs-toggle="tooltip"
                            data-bs-title="Virtual host name used in configuration"
                            data-bs-delay='{"show": 500, "hide": 100}'
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
                            <label class="form-label mb-1 small text-muted" data-bs-toggle="tooltip" data-bs-title="Regular expression to match incoming request URLs" data-bs-delay='{"show": 500, "hide": 100}'>Pattern (regex)</label>
                            <input class="form-control form-control-sm" v-model="vhost.pattern" placeholder=".*" data-bs-toggle="tooltip" data-bs-title="Regex pattern (e.g., .* for all requests, .*/live/.* for specific paths)" data-bs-delay='{"show": 500, "hide": 100}' />
                          </div>
                          <div class="col-6">
                            <label class="form-label mb-1 small text-muted" data-bs-toggle="tooltip" data-bs-title="Upstream origin to route matching requests to" data-bs-delay='{"show": 500, "hide": 100}'>Upstream</label>
                            <select class="form-select form-select-sm" v-model="vhost.upstream" data-bs-toggle="tooltip" data-bs-title="Select the upstream server to proxy requests to" data-bs-delay='{"show": 500, "hide": 100}'>
                              <option value="">-- select --</option>
                              <option v-for="u in config.upstreams" :key="u.name" :value="u.name">{{ u.name }}</option>
                            </select>
                          </div>
                        </div>

                        <div class="d-flex justify-content-between align-items-center mb-2">
                          <span class="small text-muted" data-bs-toggle="tooltip" data-bs-title="Listen addresses for this virtual host" data-bs-delay='{"show": 500, "hide": 100}'>Endpoints</span>
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
                              data-bs-toggle="tooltip"
                              data-bs-title="Protocol: HTTP or HTTPS"
                              data-bs-delay='{"show": 500, "hide": 100}'
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
                              data-bs-toggle="tooltip"
                              data-bs-title="Port number (1-65535)"
                              data-bs-delay='{"show": 500, "hide": 100}'
                            />
                            <button class="btn btn-outline-danger btn-sm" @click="removeVhostEndpoint(vhost, epIdx)">
                              <i class="bi bi-trash3"></i>
                            </button>
                          </div>
                        </div>

                        <div v-if="vhostHasHttps(vhost)">
                          <label class="form-label mb-1 small text-muted" data-bs-toggle="tooltip" data-bs-title="SSL/TLS certificate configuration for HTTPS endpoints" data-bs-delay='{"show": 500, "hide": 100}'>Certificate</label>
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
                                data-bs-toggle="tooltip"
                                data-bs-title="Use self-signed certificate (auto-generated)"
                                data-bs-delay='{"show": 500, "hide": 100}'
                              />
                              <label class="form-check-label small" :for="'cert-self-' + vIdx" data-bs-toggle="tooltip" data-bs-title="Use self-signed certificate (auto-generated)" data-bs-delay='{"show": 500, "hide": 100}'>Self-signed</label>
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
                                data-bs-toggle="tooltip"
                                data-bs-title="Use custom certificate file"
                                data-bs-delay='{"show": 500, "hide": 100}'
                              />
                              <label class="form-check-label small" :for="'cert-file-' + vIdx" data-bs-toggle="tooltip" data-bs-title="Use custom certificate file" data-bs-delay='{"show": 500, "hide": 100}'>Custom</label>
                            </div>
                          </div>
                          <input
                            v-if="!vhost.cert_file && vhost.cert_file !== ''"
                            class="form-control form-control-sm"
                            v-model="vhost.cert_selfsigned"
                            placeholder="default"
                            data-bs-toggle="tooltip"
                            data-bs-title="Self-signed certificate identifier (e.g., 'default', 'custom-cert')"
                            data-bs-delay='{"show": 500, "hide": 100}'
                          />
                          <input
                            v-else
                            class="form-control form-control-sm"
                            v-model="vhost.cert_file"
                            placeholder='read_file("/etc/...cert"), read_file("/etc/...key")'
                            data-bs-toggle="tooltip"
                            data-bs-title='Custom certificate file reference (e.g., read_file("/etc/certs/cert.pem"), read_file("/etc/certs/key.pem"))'
                            data-bs-delay='{"show": 500, "hide": 100}'
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="config.vhosts.length === 0" class="col-12 text-muted small">No virtual hosts configured.</div>
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
                    <i class="bi bi-send me-1"></i>Test
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

          <div v-else-if="activePanel === 'output'" class="panel-area panel-area-output">
            <div class="card panel-card panel-card-output">
              <div class="card-body card-body-output">
                <div class="mb-3 output-section-fixed">
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
                <div class="mb-3 output-section-fixed">
                  <div class="small text-muted mb-1">Docker Output</div>
                  <div v-if="statusOutput" class="output-bar">
                    <pre class="output-bar-pre">{{ statusOutput }}</pre>
                  </div>
                  <div v-else class="text-muted small">No docker output available yet.</div>
                </div>
                <div class="output-section-grow">
                  <div class="small text-muted mb-1">Docker Logs</div>
                  <div v-if="dockerLogs" class="output-bar output-bar-large output-bar-fill">
                    <pre class="output-bar-pre output-bar-pre-large output-bar-pre-fill">{{ dockerLogs }}</pre>
                  </div>
                  <div v-else class="text-muted small">No docker logs available yet.</div>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="activePanel === 'traffic'" class="panel-area panel-area-output">
            <div class="card panel-card panel-card-output">
              <div class="card-body card-body-output">
                <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3 output-section-fixed">
                  <h6 class="card-title mb-0">Origin Traffic</h6>
                  <div class="d-flex align-items-center gap-2 flex-wrap">
                    <input
                      class="form-control form-control-sm"
                      style="width: 190px;"
                      v-model="trafficHostFilter"
                      placeholder="Origin host"
                    />
                    <div class="form-check form-check-inline mb-0">
                      <input
                        id="traffic-manifest-only"
                        class="form-check-input"
                        type="checkbox"
                        v-model="trafficManifestOnly"
                      />
                      <label class="form-check-label small" for="traffic-manifest-only">Manifest only</label>
                    </div>
                    <button class="btn btn-outline-primary btn-sm" :disabled="loadingTraffic" @click="loadOriginTraffic">
                      <i class="bi bi-arrow-repeat me-1"></i>Refresh
                    </button>
                  </div>
                </div>

                <div class="stats-grid mb-3 output-section-fixed">
                  <div class="stats-tile">
                    <div class="stats-label">Before Request</div>
                    <div class="stats-value">{{ originTrafficSummary.before_request || 0 }}</div>
                  </div>
                  <div class="stats-tile">
                    <div class="stats-label">After Reply</div>
                    <div class="stats-value">{{ originTrafficSummary.after_reply || 0 }}</div>
                  </div>
                  <div class="stats-tile">
                    <div class="stats-label">Manifest</div>
                    <div class="stats-value">{{ originTrafficSummary.manifest || 0 }}</div>
                  </div>
                  <div class="stats-tile">
                    <div class="stats-label">Events</div>
                    <div class="stats-value">{{ originTraffic.length }}</div>
                  </div>
                </div>

                <div v-if="trafficError" class="text-danger small mb-2 output-section-fixed">{{ trafficError }}</div>

                <div v-if="originTraffic.length" class="traffic-table-wrap output-section-grow">
                  <table class="traffic-table">
                    <thead>
                      <tr>
                        <th>Upstream</th>
                        <th>Phase</th>
                        <th>URL</th>
                        <th>Cache-Control</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(event, index) in originTraffic" :key="event.url + '-' + index">
                        <td class="traffic-cell-upstream">{{ event.upstream }}</td>
                        <td>
                          <span class="badge" :class="event.phase === 'before_request' ? 'text-bg-primary' : 'text-bg-success'">{{ event.phase }}</span>
                        </td>
                        <td class="traffic-cell-url">{{ event.url }}</td>
                        <td class="traffic-cell-cache">{{ event.cache_control || '-' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else class="text-muted small">No matching traffic event found in current Docker logs.</div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <footer class="main-footer">
        <img class="footer-logo" src="/assets/Logo Broadpeak.svg" alt="Broadpeak logo" />
      </footer>

      <div class="toast-overlay">
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
              <button type="button" class="btn btn-outline-secondary" :disabled="loadingConfig" @click="closeLoadConfigModal">Cancel</button>
              <button type="button" class="btn btn-primary" :disabled="loadingConfig" @click="loadSelectedConfig">Load</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
}).mount("#app");