/* vim: set ft=cpp: */
// clang-format off
%link libstitcher.so;
// clang-format on

/* === Stitcher configuration ============= */
// Initialize stitcher plugin
using namespace stitcher;
using namespace stitcher_conf;
init_stitcher(product, "upstream_stitcher");

/* === product settings =================== */
product.default_settings.network_monitoring.is_enabled = true;
product.default_settings.monitoring.metrics.is_enabled = true;
product.default_settings.monitoring.storage.is_enabled = true;
product.default_settings.monitoring.services_upstreams.active.is_enabled = true;
product.default_settings.monitoring.services_upstreams.passive.is_enabled = true;

product.default_settings.req_logs_config.txt_config = {
    .is_activated = true,
    .target_folder = "/var/log/broadpeak/hpc",
    .rotate_size_limit = 64L * 1024L * 1024L,
    .max_log_size = 8ULL * 1024ULL * 1024ULL * 1024ULL / seastar::smp::count,
    .compression_codec = "null",
};

/* ======================================== */
/* === STITCHER configuration file ======== */
/* ======================================== */

/* === Prometheus port ===================== */
config.prometheus_port = 11450;
config.cache.ram_only = true;
config.cache.ram.max_memory = 1_Gio; // per shard

/* === services upstream config ====================== */
default_config({
                // ui_meta: {"label":"DVR window query parameter","tooltip":"URL query parameter name used for DVR window length (example: dvr_window_length)."}
                .param_dvrwindow = "dvr_window_length",
                // ui_meta: {"label":"Session ID query parameter","tooltip":"URL query parameter name carrying the session identifier (example: sessionid)."}
                .param_sessionid = "sessionid",
                // ui_meta: {"label":"Initial DVR window","tooltip":"Initial DVR window duration when a session starts (example: 8h, 600s)."}
                .init_dvrwindow = 8h,
                // ui_meta: {"label":"DVR window increment","tooltip":"Step used to increase the DVR window between updates (example: 30s)."}
                .incr_dvrwindow = 30s,
                // ui_meta: {"label":"Session expiration","tooltip":"Idle timeout before a session expires (example: 15s)."}
                .session_expiration = 15s,
                // ui_meta: {"label":"Manifest expiration","tooltip":"Validity/cache duration for generated manifests (example: 1s)."}
                .manifest_expiration = 1s
});
service_config("ARTE", {.init_dvrwindow = 600s, .param_dvrwindow = "30s"});
service_config("7ANS", {.init_dvrwindow = 600s, .param_dvrwindow = "30s"});

/* === UPSTREAM ORIGIN ===================== */
config.upstreams["upstream_origin"] = {
    .max_redirect = 10,
    .before_request = [](cache::upstream_request& request) { stitcher::log().debug("upstream_origin before_request url={}", request.get_url()); },
    .after_reply =
        [](cache::upstream_request& request, cache::upstream_reply& reply) {
            stitcher::log().debug("upstream_origin after_reply url={} Cache-Control={} Expires={}",
                                  request.get_url(),
                                  reply.get_header(proxygen::HTTP_HEADER_CACHE_CONTROL), reply.get_header(proxygen::HTTP_HEADER_EXPIRES));
            reply.remove_header(proxygen::HTTP_HEADER_CACHE_CONTROL);
            reply.remove_header(proxygen::HTTP_HEADER_EXPIRES);
        },
    .default_expiration_function =
        hpc::expire::by_extension({{".mpd", 1s, 100ms}, {".m3u8", 1s, 100ms}, {".mp4", 7200s, 100ms}, {".ts", 7200s, 100ms}, {".dash", 7200s, 100ms}}),
    .endpoints = {"http://197.30.248.202"},
};

config.upstreams["upstream_qos"] = {
    .max_redirect = 10,
    .before_request = [](cache::upstream_request& request) { stitcher::log().debug("upstream_qos before_request url={}", request.get_url()); },
    .after_reply =
        [](cache::upstream_request& request, cache::upstream_reply& reply) {
            stitcher::log().debug("upstream_qos after_reply url={} Cache-Control={} Expires={}",
                                  request.get_url(),
                                  reply.get_header(proxygen::HTTP_HEADER_CACHE_CONTROL), reply.get_header(proxygen::HTTP_HEADER_EXPIRES));
            reply.remove_header(proxygen::HTTP_HEADER_CACHE_CONTROL);
            reply.remove_header(proxygen::HTTP_HEADER_EXPIRES);
        },
    .default_expiration_function =
        hpc::expire::by_extension({{".mpd", 1s, 100ms}, {".m3u8", 1s, 100ms}, {".mp4", 7200s, 100ms}, {".ts", 7200s, 100ms}, {".dash", 7200s, 100ms}}),
    .endpoints = {"http://qos.example.com"},
};

auto& upstream_stitcher_conf = config.upstreams["upstream_stitcher"];
upstream_stitcher_conf.after_reply = [](const cache::upstream_request&, cache::upstream_reply& reply) {
    reply.remove_header(proxygen::HTTP_HEADER_CACHE_CONTROL);
    reply.remove_header(proxygen::HTTP_HEADER_EXPIRES);
};

/* === WEB server listening port =========== */
auto& vh = config.vhosts["vhost_streaming"];
vh.pattern = ".*";
vh.endpoints = {endpoint(HTTP, 80), endpoint(HTTPS, 443)};
vh.certificates = {selfsigned_certificate("default")};

auto& vh_qos = config.vhosts["vhost_qos"];
vh_qos.pattern = ".*";
vh_qos.endpoints = {endpoint(HTTP, 82)};

/* === Register handlers on vhosts ========== */

register_vhost(vh, "upstream_stitcher", "upstream_origin");
register_vhost(vh_qos, "upstream_stitcher", "upstream_qos");

/* === Initialize request_callback function to remove cache disabling headers === */
request_callback() = [](cache::client_request& request) {
    request.remove_header(proxygen::HTTP_HEADER_CACHE_CONTROL);
    request.remove_header(proxygen::HTTP_HEADER_PRAGMA);
};
