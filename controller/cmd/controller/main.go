package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"controller/internal/config"
	httpapi "controller/internal/http"
	"controller/internal/metrics"
	"controller/internal/policy"
)

func main() {
	cfgPath := os.Getenv("CONTROLLER_CONFIG_PATH")
	if cfgPath == "" {
		cfgPath = "config.yaml"
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	engine := policy.NewEngine(cfg)
	metricsStore := metrics.NewLogStore()

	ctrl := &httpapi.Controller{
		Cfg:        cfg,
		Engine:     engine,
		Metrics:    metricsStore,
		ConfigPath: cfgPath,
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	apiToken := cfg.ApiToken

	r.Route("/api/v0", func(api chi.Router) {
		api.Use(httpapi.AuthMiddleware(apiToken))

		api.Post("/bootstrap", ctrl.HandleBootstrap)
		api.Post("/decision", ctrl.HandleDecision)
		api.Post("/metrics", ctrl.HandleMetrics)

		api.Post("/admin/reload", ctrl.HandleAdminReload)
		api.Post("/debug/decision", ctrl.HandleDebugDecision)
	})

	addr := os.Getenv("CONTROLLER_LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("controller listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
