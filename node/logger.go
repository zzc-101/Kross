package main

import (
	"log/slog"
	"os"
	"strings"
)

func initLogger(nodeID string) {
	handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel()})
	logger := slog.New(handler).With("service", "kross-node")
	if nodeID != "" {
		logger = logger.With("nodeId", nodeID)
	}
	slog.SetDefault(logger)
}

func logLevel() slog.Leveler {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("KROSS_LOG_LEVEL"))) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
