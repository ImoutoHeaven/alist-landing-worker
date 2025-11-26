package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"controller/internal/metrics"
)

type stubMetricsStore struct {
	last   metrics.Batch
	called int
}

func (s *stubMetricsStore) Append(batch metrics.Batch) error {
	s.last = batch
	s.called++
	return nil
}

func TestHandleMetricsAcceptsSlotHandlerPayload(t *testing.T) {
	store := &stubMetricsStore{}
	ctrl := &Controller{Metrics: store}

	payload := map[string]any{
		"source":      "slot-handler",
		"env":         "staging",
		"instance_id": "slot-1",
		"events": []map[string]any{
			{
				"type":          "slot_handler.snapshot",
				"ts":            "1732646400123",
				"configVersion": "cfg-1",
				"counts":        map[string]any{"granted": 3, "timeout": 1},
				"sessions":      map[string]any{"total": 2, "pending": 1},
				"smoothHosts":   4,
				"appName":       "slot-handler",
				"appVersion":    "v1",
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v0/metrics", bytes.NewReader(body))
	w := httptest.NewRecorder()

	ctrl.HandleMetrics(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, w.Code)
	}
	if store.called != 1 {
		t.Fatalf("expected metrics store append once, got %d", store.called)
	}

	if store.last.Source != "slot-handler" || store.last.Env != "staging" || store.last.InstanceID != "slot-1" {
		t.Fatalf("unexpected batch metadata: %+v", store.last)
	}

	if len(store.last.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(store.last.Events))
	}

	ev := store.last.Events[0]
	if ev.Type != "slot_handler.snapshot" {
		t.Fatalf("unexpected event type: %s", ev.Type)
	}
	if ev.Timestamp != 1732646400123 {
		t.Fatalf("unexpected timestamp: %d", ev.Timestamp)
	}

	if cfgVersion, ok := ev.Data["configVersion"]; !ok || cfgVersion != "cfg-1" {
		t.Fatalf("missing or wrong configVersion: %v", ev.Data["configVersion"])
	}

	counts, ok := ev.Data["counts"].(map[string]any)
	if !ok {
		t.Fatalf("counts not preserved: %#v", ev.Data["counts"])
	}
	if _, ok := counts["granted"]; !ok {
		t.Fatalf("counts.granted missing: %#v", counts)
	}
	if sessions, ok := ev.Data["sessions"].(map[string]any); !ok || sessions["total"] != float64(2) {
		t.Fatalf("sessions not preserved: %#v", ev.Data["sessions"])
	}
}
