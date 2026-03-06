package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"

	"controller/internal/config"
)

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
