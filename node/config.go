package main

import (
	"fmt"
	"os"
	"strings"
)

type config struct {
	controlPlaneURL       string
	nodeToken             string
	nodeID                string
	workerImage           string
	workerStorage         string
	juicefsMount          string
	orchestratorManagerID string
}

func loadConfig() (config, error) {
	cfg := config{
		controlPlaneURL:       strings.TrimSpace(os.Getenv("KROSS_CONTROL_PLANE_URL")),
		nodeToken:             os.Getenv("KROSS_NODE_TOKEN"),
		nodeID:                strings.TrimSpace(os.Getenv("KROSS_NODE_ID")),
		workerImage:           envOr("KROSS_WORKER_IMAGE", "kross-worker:local"),
		workerStorage:         strings.ToLower(envOr("KROSS_WORKER_STORAGE", "juicefs")),
		juicefsMount:          envOr("KROSS_JUICEFS_MOUNT", "/var/lib/kross/jfs"),
		orchestratorManagerID: envOr("KROSS_ORCHESTRATOR_MANAGER_ID", "kross-saas"),
	}
	if cfg.nodeID == "" {
		cfg.nodeID = envOr("HOSTNAME", "")
	}
	if cfg.nodeID == "" {
		return cfg, fmt.Errorf("KROSS_NODE_ID is required")
	}
	if cfg.controlPlaneURL == "" {
		return cfg, fmt.Errorf("KROSS_CONTROL_PLANE_URL is required")
	}
	if strings.TrimSpace(cfg.nodeToken) == "" {
		return cfg, fmt.Errorf("KROSS_NODE_TOKEN is required")
	}
	if cfg.workerStorage != "local" && cfg.workerStorage != "juicefs" {
		return cfg, fmt.Errorf("unknown KROSS_WORKER_STORAGE: %s", cfg.workerStorage)
	}
	return cfg, nil
}

func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}
