package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDownloadDBCacheEnabledRequired(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config.yaml: %v", err)
	}

	original := string(data)
	if !strings.Contains(original, "cacheEnabled:") {
		t.Fatalf("config.yaml missing cacheEnabled:")
	}

	mutated := strings.Replace(original, "cacheEnabled:", "cacheEnabled_missing:", 1)
	if mutated == original {
		t.Fatalf("failed to mutate cacheEnabled in config.yaml")
	}

	tmpPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(tmpPath, []byte(mutated), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}

	_, err = Load(tmpPath)
	if err == nil {
		t.Fatalf("expected Load to fail when cacheEnabled is missing")
	}
	if !strings.Contains(err.Error(), "download.db.cacheEnabled is required for env staging") {
		t.Fatalf("unexpected error: %v", err)
	}
}
