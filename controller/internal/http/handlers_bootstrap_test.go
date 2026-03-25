package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
