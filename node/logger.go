package main

import (
	"log/slog"
	"os"
)

func initLogger(nodeID string) {
	handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
	logger := slog.New(handler).With("service", "kross-node")
	if nodeID != "" {
		logger = logger.With("nodeId", nodeID)
	}
	slog.SetDefault(logger)
}
