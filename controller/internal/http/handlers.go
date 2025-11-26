package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"

	"controller/internal/config"
	"controller/internal/metrics"
	"controller/internal/policy"
)

// Controller bundles config, engine, and metrics store for handlers.
type Controller struct {
	mu         sync.RWMutex
	Cfg        *config.RootConfig
	Engine     *policy.Engine
	Metrics    metrics.Store
	ConfigPath string
}

type bootstrapRequest struct {
	Role          string `json:"role"`
	Env           string `json:"env"`
	InstanceID    string `json:"instance_id"`
	ClientIP      string `json:"client_ip"`
	ClientASN     int    `json:"client_asn"`
	ClientCountry string `json:"client_country"`
}

type bootstrapResponse struct {
	ConfigVersion string                    `json:"configVersion"`
	TTLSeconds    int                       `json:"ttlSeconds"`
	Common        config.CommonConfig       `json:"common"`
	Landing       config.LandingConfig      `json:"landing"`
	Download      config.DownloadConfig     `json:"download"`
	SlotHandler   *config.SlotHandlerConfig `json:"slotHandler,omitempty"`
}

type decisionRequest struct {
	Role             string                `json:"role"`
	Env              string                `json:"env"`
	InstanceID       string                `json:"instance_id"`
	Request          policy.RequestContext `json:"request"`
	BootstrapVersion string                `json:"bootstrapVersion"`
}

type metricsRequest struct {
	Source     string                   `json:"source"`
	Env        string                   `json:"env"`
	InstanceID string                   `json:"instance_id"`
	Events     []map[string]interface{} `json:"events"`
}

// HandleBootstrap returns the static bootstrap payload.
func (c *Controller) HandleBootstrap(w http.ResponseWriter, r *http.Request) {
	var req bootstrapRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	cfg := c.currentConfig()
	if cfg == nil {
		http.Error(w, "config not loaded", http.StatusInternalServerError)
		return
	}

	envCfg, ok := cfg.Envs[req.Env]
	if !ok {
		http.Error(w, "unknown env", http.StatusBadRequest)
		return
	}

	resp := bootstrapResponse{
		ConfigVersion: cfg.BootstrapVersion,
		TTLSeconds:    300,
		Common:        envCfg.Common,
		Landing:       envCfg.Landing,
		Download:      envCfg.Download,
	}

	if req.Role == "slot-handler" {
		resp.SlotHandler = &envCfg.SlotHandler
	}

	writeJSON(w, resp)
}

// HandleDecision calls the policy engine for a decision.
func (c *Controller) HandleDecision(w http.ResponseWriter, r *http.Request) {
	var req decisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	engine := c.currentEngine()
	if engine == nil {
		http.Error(w, "engine not initialized", http.StatusInternalServerError)
		return
	}

	ctx := policy.DecisionContext{
		Role:       req.Role,
		Env:        req.Env,
		InstanceID: req.InstanceID,
		Request:    req.Request,
	}

	res, err := engine.EvalDecision(ctx)
	if err != nil {
		http.Error(w, "decision error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, res)
}

// HandleMetrics accepts metrics batches from controlled nodes.
func (c *Controller) HandleMetrics(w http.ResponseWriter, r *http.Request) {
	var req metricsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if c.Metrics == nil {
		http.Error(w, "metrics store not configured", http.StatusInternalServerError)
		return
	}

	batch := metrics.Batch{
		Source:     req.Source,
		Env:        req.Env,
		InstanceID: req.InstanceID,
		Events:     make([]metrics.Event, 0, len(req.Events)),
	}

	for _, raw := range req.Events {
		evType, _ := raw["type"].(string)
		ts := parseTimestamp(raw["ts"])

		data := make(map[string]interface{}, len(raw))
		for k, v := range raw {
			if k == "type" || k == "ts" {
				continue
			}
			data[k] = v
		}

		batch.Events = append(batch.Events, metrics.Event{
			Type:      evType,
			Timestamp: int64(ts),
			Data:      data,
		})
	}

	if err := c.Metrics.Append(batch); err != nil {
		http.Error(w, "metrics error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleAdminReload reloads config and rebuilds the engine.
func (c *Controller) HandleAdminReload(w http.ResponseWriter, r *http.Request) {
	cfgPath := c.ConfigPath
	if cfgPath == "" {
		cfgPath = "config.yaml"
	}

	newCfg, err := config.Load(cfgPath)
	if err != nil {
		http.Error(w, "reload config failed", http.StatusInternalServerError)
		return
	}

	newEngine := policy.NewEngine(newCfg)

	c.mu.Lock()
	c.Cfg = newCfg
	c.Engine = newEngine
	c.mu.Unlock()

	writeJSON(w, map[string]any{
		"ok":            true,
		"configVersion": newCfg.BootstrapVersion,
		"rulesVersion":  newCfg.RulesVersion,
	})
}

// HandleDebugDecision mirrors HandleDecision for debugging.
func (c *Controller) HandleDebugDecision(w http.ResponseWriter, r *http.Request) {
	var req decisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	engine := c.currentEngine()
	if engine == nil {
		http.Error(w, "engine not initialized", http.StatusInternalServerError)
		return
	}

	ctx := policy.DecisionContext{
		Role:       req.Role,
		Env:        req.Env,
		InstanceID: req.InstanceID,
		Request:    req.Request,
	}

	res, err := engine.EvalDecision(ctx)
	if err != nil {
		http.Error(w, "decision error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, res)
}

func (c *Controller) currentConfig() *config.RootConfig {
	c.mu.RLock()
	cfg := c.Cfg
	c.mu.RUnlock()
	return cfg
}

func (c *Controller) currentEngine() *policy.Engine {
	c.mu.RLock()
	engine := c.Engine
	c.mu.RUnlock()
	return engine
}

func parseTimestamp(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case float32:
		return int64(t)
	case int64:
		return t
	case int32:
		return int64(t)
	case int:
		return int64(t)
	case json.Number:
		if ts, err := t.Int64(); err == nil {
			return ts
		}
	case string:
		if ts, err := strconv.ParseInt(t, 10, 64); err == nil {
			return ts
		}
	}
	return 0
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	if err := enc.Encode(v); err != nil {
		http.Error(w, errors.New("encode response failed").Error(), http.StatusInternalServerError)
	}
}
