package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"controller/internal/config"
)

func bootstrapBodyForRole(t *testing.T, role string) string {
	t.Helper()

	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"`+role+`","env":"staging"}`))
	w := httptest.NewRecorder()

	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	return w.Body.String()
}

func TestBootstrapOmitsLegacyThrottleFields(t *testing.T) {
	body := bootstrapBodyForRole(t, "download")

	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("decode bootstrap body: %v", err)
	}
	download, ok := resp["download"].(map[string]any)
	if !ok {
		t.Fatalf("bootstrap missing download payload: %s", body)
	}
	throttleProfiles, ok := download["throttleProfiles"].(map[string]any)
	if !ok {
		t.Fatalf("bootstrap missing download.throttleProfiles: %s", body)
	}
	defaultProfile, ok := throttleProfiles["default"].(map[string]any)
	if !ok {
		t.Fatalf("bootstrap missing default throttle profile: %s", body)
	}
	expectedFields := map[string]struct{}{
		"hostPatterns":             {},
		"openCapSeconds":           {},
		"openThresholdPercent":     {},
		"closeThresholdPercent":    {},
		"ewmaSpan":                 {},
		"consecutiveThreshold":     {},
		"minSamplesBeforeEwmaOpen": {},
		"idleResetSeconds":         {},
		"halfOpenSuccessThreshold": {},
		"halfOpenCloseMode":        {},
		"halfOpenMaxProbeCount":    {},
		"halfOpenMaxSeconds":       {},
		"halfOpenTimeoutMode":      {},
		"protectHttpCodes":         {},
	}
	if len(defaultProfile) != len(expectedFields) {
		t.Fatalf("unexpected throttle field count in bootstrap: %+v", defaultProfile)
	}
	for field := range defaultProfile {
		if _, ok := expectedFields[field]; !ok {
			t.Fatalf("unexpected throttle field in bootstrap: %s", field)
		}
	}
	for field := range expectedFields {
		if _, ok := defaultProfile[field]; !ok {
			t.Fatalf("bootstrap missing %s: %+v", field, defaultProfile)
		}
	}
}

func TestBootstrapIncludesWarmupBreakerFields(t *testing.T) {
	body := bootstrapBodyForRole(t, "download")
	if !strings.Contains(body, "minSamplesBeforeEwmaOpen") {
		t.Fatalf("bootstrap missing minSamplesBeforeEwmaOpen: %s", body)
	}
	if !strings.Contains(body, "idleResetSeconds") {
		t.Fatalf("bootstrap missing idleResetSeconds: %s", body)
	}
}

func TestHandleBootstrapDownloadIncludesSlotHandlerAuthHeader(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"download","env":"staging"}`))
	w := httptest.NewRecorder()

	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp struct {
		Download struct {
			FairQueue struct {
				SlotHandlerAuthHeader string `json:"slotHandlerAuthHeader"`
			} `json:"fairQueue"`
		} `json:"download"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	if resp.Download.FairQueue.SlotHandlerAuthHeader != "X-FQ-Auth" {
		t.Fatalf("missing synced auth header in bootstrap")
	}
}

func TestHandleBootstrapDownloadNormalizesSlotHandlerAuthHeaderWhitespace(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	staging := cfg.Envs["staging"]
	staging.Download.FairQueue.SlotHandlerAuthHeader = " X-FQ-Auth "
	staging.SlotHandler.Auth.Header = "\tX-FQ-Auth "
	cfg.Envs["staging"] = staging

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() failed: %v", err)
	}

	normalized := cfg.Envs["staging"]
	if normalized.Download.FairQueue.SlotHandlerAuthHeader != "X-FQ-Auth" {
		t.Fatalf("expected normalized download slotHandlerAuthHeader, got %q", normalized.Download.FairQueue.SlotHandlerAuthHeader)
	}
	if normalized.SlotHandler.Auth.Header != "X-FQ-Auth" {
		t.Fatalf("expected normalized slotHandler auth header, got %q", normalized.SlotHandler.Auth.Header)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"download","env":"staging"}`))
	w := httptest.NewRecorder()

	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp struct {
		Download struct {
			FairQueue struct {
				SlotHandlerAuthHeader string `json:"slotHandlerAuthHeader"`
			} `json:"fairQueue"`
		} `json:"download"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	if resp.Download.FairQueue.SlotHandlerAuthHeader != "X-FQ-Auth" {
		t.Fatalf("expected normalized slotHandlerAuthHeader in bootstrap, got %q", resp.Download.FairQueue.SlotHandlerAuthHeader)
	}
}

func TestHandleBootstrapDownloadIncludesTrueConcurrencyContract(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"download","env":"staging"}`))
	w := httptest.NewRecorder()
	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}
	body := w.Body.Bytes()

	var rawResp struct {
		Download struct {
			TrueConcurrency map[string]json.RawMessage `json:"trueConcurrency"`
		} `json:"download"`
	}
	if err := json.Unmarshal(body, &rawResp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	expectedKeys := map[string]struct{}{
		"enabled":           {},
		"hostPatterns":      {},
		"handlerUrl":        {},
		"handlerAuthKey":    {},
		"handlerAuthHeader": {},
		"siteBucket":        {},
		"acquireTimeoutMs":  {},
		"releaseTimeoutMs":  {},
	}
	if len(rawResp.Download.TrueConcurrency) != len(expectedKeys) {
		t.Fatalf("unexpected trueConcurrency field count: got %d want %d (%v)", len(rawResp.Download.TrueConcurrency), len(expectedKeys), rawResp.Download.TrueConcurrency)
	}
	for key := range rawResp.Download.TrueConcurrency {
		if _, ok := expectedKeys[key]; !ok {
			t.Fatalf("unexpected trueConcurrency field in bootstrap: %s", key)
		}
	}
	for key := range expectedKeys {
		if _, ok := rawResp.Download.TrueConcurrency[key]; !ok {
			t.Fatalf("bootstrap missing trueConcurrency field: %s", key)
		}
	}

	var resp struct {
		Download struct {
			FairQueue struct {
				SiteBucket struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"fairQueue"`
			TrueConcurrency struct {
				Enabled           bool     `json:"enabled"`
				HostPatterns      []string `json:"hostPatterns"`
				HandlerURL        string   `json:"handlerUrl"`
				HandlerAuthKey    string   `json:"handlerAuthKey"`
				HandlerAuthHeader string   `json:"handlerAuthHeader"`
				AcquireTimeoutMs  int      `json:"acquireTimeoutMs"`
				ReleaseTimeoutMs  int      `json:"releaseTimeoutMs"`
				SiteBucket        struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"trueConcurrency"`
		} `json:"download"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	if !resp.Download.TrueConcurrency.Enabled {
		t.Fatalf("bootstrap missing enabled trueConcurrency contract")
	}
	if !reflect.DeepEqual(resp.Download.TrueConcurrency.HostPatterns, []string{"*.sharepoint.com"}) {
		t.Fatalf("unexpected trueConcurrency hostPatterns: %+v", resp.Download.TrueConcurrency.HostPatterns)
	}
	if resp.Download.TrueConcurrency.HandlerURL != "https://concurrency-handler-staging.example.com" {
		t.Fatalf("unexpected trueConcurrency handlerUrl: %q", resp.Download.TrueConcurrency.HandlerURL)
	}
	if resp.Download.TrueConcurrency.HandlerAuthKey != "replace-with-concurrency-handler-key" {
		t.Fatalf("unexpected trueConcurrency handlerAuthKey: %q", resp.Download.TrueConcurrency.HandlerAuthKey)
	}
	if resp.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
		t.Fatalf("unexpected trueConcurrency handlerAuthHeader: %q", resp.Download.TrueConcurrency.HandlerAuthHeader)
	}
	if resp.Download.TrueConcurrency.AcquireTimeoutMs != 11500 {
		t.Fatalf("unexpected trueConcurrency acquireTimeoutMs: %d", resp.Download.TrueConcurrency.AcquireTimeoutMs)
	}
	if resp.Download.TrueConcurrency.ReleaseTimeoutMs != 1500 {
		t.Fatalf("unexpected trueConcurrency releaseTimeoutMs: %d", resp.Download.TrueConcurrency.ReleaseTimeoutMs)
	}
	if resp.Download.FairQueue.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("unexpected fairQueue siteBucket.mode: %q", resp.Download.FairQueue.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.FairQueue.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("unexpected fairQueue siteBucket.modes: %+v", resp.Download.FairQueue.SiteBucket.Modes)
	}
	if resp.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("unexpected trueConcurrency siteBucket.mode: %q", resp.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("unexpected trueConcurrency siteBucket.modes: %+v", resp.Download.TrueConcurrency.SiteBucket.Modes)
	}
}

func TestHandleBootstrapDownloadNormalizesTrueConcurrencyFields(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	staging := cfg.Envs["staging"]
	staging.Download.TrueConcurrency.HandlerURL = " https://concurrency-handler-staging.example.com "
	staging.Download.TrueConcurrency.HandlerAuthKey = " replace-with-concurrency-handler-key "
	staging.Download.TrueConcurrency.HandlerAuthHeader = " x-cq-auth "
	staging.Download.TrueConcurrency.HostPatterns = []string{"  *.sharepoint.com  ", "   "}
	staging.Download.TrueConcurrency.SiteBucket.Mode = " SharePoint "
	cfg.Envs["staging"] = staging

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() failed: %v", err)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"download","env":"staging"}`))
	w := httptest.NewRecorder()
	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp struct {
		Download struct {
			FairQueue struct {
				SiteBucket struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"fairQueue"`
			TrueConcurrency struct {
				HostPatterns      []string `json:"hostPatterns"`
				HandlerURL        string   `json:"handlerUrl"`
				HandlerAuthKey    string   `json:"handlerAuthKey"`
				HandlerAuthHeader string   `json:"handlerAuthHeader"`
				SiteBucket        struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"trueConcurrency"`
		} `json:"download"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	if resp.Download.TrueConcurrency.HandlerURL != "https://concurrency-handler-staging.example.com" {
		t.Fatalf("expected normalized trueConcurrency handlerUrl, got %q", resp.Download.TrueConcurrency.HandlerURL)
	}
	if resp.Download.TrueConcurrency.HandlerAuthKey != "replace-with-concurrency-handler-key" {
		t.Fatalf("expected normalized trueConcurrency handlerAuthKey, got %q", resp.Download.TrueConcurrency.HandlerAuthKey)
	}
	if resp.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
		t.Fatalf("expected normalized trueConcurrency auth header, got %q", resp.Download.TrueConcurrency.HandlerAuthHeader)
	}
	if !reflect.DeepEqual(resp.Download.TrueConcurrency.HostPatterns, []string{"*.sharepoint.com"}) {
		t.Fatalf("expected normalized trueConcurrency hostPatterns, got %+v", resp.Download.TrueConcurrency.HostPatterns)
	}
	if resp.Download.FairQueue.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("expected normalized fairQueue siteBucket.mode, got %q", resp.Download.FairQueue.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.FairQueue.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("expected normalized fairQueue siteBucket.modes, got %+v", resp.Download.FairQueue.SiteBucket.Modes)
	}
	if resp.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("expected normalized trueConcurrency siteBucket.mode, got %q", resp.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("expected normalized trueConcurrency siteBucket.modes, got %+v", resp.Download.TrueConcurrency.SiteBucket.Modes)
	}
}

func TestHandleBootstrapDownloadIncludesMultiModeSiteBucketContract(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	staging := cfg.Envs["staging"]
	staging.Download.FairQueue.SiteBucket.Mode = "googledrive"
	staging.Download.FairQueue.SiteBucket.Modes = []string{" SharePoint ", "googledrive", "sharepoint", "   "}
	staging.Download.TrueConcurrency.SiteBucket.Mode = "googledrive"
	staging.Download.TrueConcurrency.SiteBucket.Modes = []string{" SharePoint ", "googledrive", "sharepoint", "   "}
	cfg.Envs["staging"] = staging

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() failed: %v", err)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"download","env":"staging"}`))
	w := httptest.NewRecorder()
	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp struct {
		Download struct {
			FairQueue struct {
				SiteBucket struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"fairQueue"`
			TrueConcurrency struct {
				SiteBucket struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"trueConcurrency"`
		} `json:"download"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}
	if resp.Download.FairQueue.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("expected normalized fairQueue multi-mode projection, got %q", resp.Download.FairQueue.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.FairQueue.SiteBucket.Modes, []string{"sharepoint", "googledrive"}) {
		t.Fatalf("expected normalized fairQueue multi-mode set, got %+v", resp.Download.FairQueue.SiteBucket.Modes)
	}
	if resp.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("expected normalized trueConcurrency multi-mode projection, got %q", resp.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint", "googledrive"}) {
		t.Fatalf("expected normalized trueConcurrency multi-mode set, got %+v", resp.Download.TrueConcurrency.SiteBucket.Modes)
	}
}

func TestHandleBootstrapDownloadPreservesFirstOccurrenceOrderInMultiModeSiteBucket(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	staging := cfg.Envs["staging"]
	staging.Download.FairQueue.SiteBucket.Mode = "sharepoint"
	staging.Download.FairQueue.SiteBucket.Modes = []string{" googledrive ", "sharepoint", "googledrive"}
	staging.Download.TrueConcurrency.SiteBucket.Mode = "sharepoint"
	staging.Download.TrueConcurrency.SiteBucket.Modes = []string{" googledrive ", "sharepoint", "googledrive"}
	cfg.Envs["staging"] = staging

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() failed: %v", err)
	}

	ctrl := &Controller{Cfg: cfg}
	req := httptest.NewRequest(http.MethodPost, "/api/v0/bootstrap", bytes.NewBufferString(`{"role":"download","env":"staging"}`))
	w := httptest.NewRecorder()
	ctrl.HandleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp struct {
		Download struct {
			FairQueue struct {
				SiteBucket struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"fairQueue"`
			TrueConcurrency struct {
				SiteBucket struct {
					Mode  string   `json:"mode"`
					Modes []string `json:"modes"`
				} `json:"siteBucket"`
			} `json:"trueConcurrency"`
		} `json:"download"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode bootstrap response: %v", err)
	}

	if resp.Download.FairQueue.SiteBucket.Mode != "googledrive" {
		t.Fatalf("expected fairQueue multi-mode projection to preserve first occurrence, got %q", resp.Download.FairQueue.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.FairQueue.SiteBucket.Modes, []string{"googledrive", "sharepoint"}) {
		t.Fatalf("expected fairQueue multi-mode order to be preserved, got %+v", resp.Download.FairQueue.SiteBucket.Modes)
	}
	if resp.Download.TrueConcurrency.SiteBucket.Mode != "googledrive" {
		t.Fatalf("expected trueConcurrency multi-mode projection to preserve first occurrence, got %q", resp.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(resp.Download.TrueConcurrency.SiteBucket.Modes, []string{"googledrive", "sharepoint"}) {
		t.Fatalf("expected trueConcurrency multi-mode order to be preserved, got %+v", resp.Download.TrueConcurrency.SiteBucket.Modes)
	}
}

func TestReadmeDocumentsTrueConcurrencyContract(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	readmePath := filepath.Join(filepath.Dir(file), "..", "..", "README.md")

	data, err := os.ReadFile(readmePath)
	if err != nil {
		t.Fatalf("read README.md: %v", err)
	}

	text := string(data)
	for _, want := range []string{
		"download true-concurrency",
		"download.trueConcurrency.enabled",
		"download.trueConcurrency.hostPatterns",
		"download.trueConcurrency.handlerUrl",
		"download.trueConcurrency.handlerAuthKey",
		"download.trueConcurrency.handlerAuthHeader",
		"download.trueConcurrency.acquireTimeoutMs",
		"download.trueConcurrency.releaseTimeoutMs",
		"download.trueConcurrency.siteBucket.mode",
		"download.trueConcurrency.siteBucket.modes",
		"download.fairQueue.siteBucket.mode",
		"download.fairQueue.siteBucket.modes",
		"X-CQ-Auth",
		"host|sharepoint|googledrive",
		"modes is authoritative",
		"mode is legacy-compatible",
		"11500",
		"1500",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("README.md missing true-concurrency documentation: %s", want)
		}
	}
}

func TestHandleBootstrapSlotHandlerUsesAtomicAdmitRPC(t *testing.T) {
	body := bootstrapBodyForRole(t, "slot-handler")

	var resp struct {
		SlotHandler struct {
			FairQueue struct {
				RPC struct {
					TryAcquireFunc string `json:"tryAcquireFunc"`
					ReleaseFunc    string `json:"releaseFunc"`
				} `json:"rpc"`
			} `json:"fairQueue"`
		} `json:"slotHandler"`
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("decode bootstrap body: %v", err)
	}
	if resp.SlotHandler.FairQueue.RPC.TryAcquireFunc != "fq_admit_batch" {
		t.Fatalf("expected slot-handler bootstrap tryAcquireFunc fq_admit_batch, got %q", resp.SlotHandler.FairQueue.RPC.TryAcquireFunc)
	}
	if resp.SlotHandler.FairQueue.RPC.ReleaseFunc != "fq_release_dual" {
		t.Fatalf("expected slot-handler bootstrap releaseFunc fq_release_dual, got %q", resp.SlotHandler.FairQueue.RPC.ReleaseFunc)
	}
}
