package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		initLogger("")
		slog.Error("kross-node failed to start", "error", err.Error())
		os.Exit(1)
	}
	initLogger(cfg.nodeID)
	slog.Info("kross-node starting",
		"controlPlaneURL", cfg.controlPlaneURL,
		"workerImage", cfg.workerImage,
		"workerStorage", cfg.workerStorage,
		"juicefsMount", cfg.juicefsMount,
		"nodeTokenSet", strings.TrimSpace(cfg.nodeToken) != "",
	)
	runtime, err := newDockerRuntime(cfg)
	if err != nil {
		slog.Error("docker is unreachable", "error", err.Error())
		os.Exit(1)
	}
	slog.Info("connected to docker daemon")
	defer runtime.cli.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	for ctx.Err() == nil {
		if err := runSession(ctx, cfg, runtime); err != nil && ctx.Err() == nil {
			slog.Warn("kross-node disconnected", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func runSession(ctx context.Context, cfg config, runtime *dockerRuntime) error {
	wsURL, err := websocketURL(cfg.controlPlaneURL, cfg.nodeID)
	if err != nil {
		return err
	}
	slog.Info("connecting kross-node", "url", wsURL)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.nodeToken)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, resp, err := dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
			resp.Body.Close()
		}
		slog.Warn("failed to connect to control plane", "url", wsURL, "status", status, "error", err.Error())
		return err
	}
	defer conn.Close()
	slog.Info("connected to control plane", "url", wsURL)

	var writeMu sync.Mutex
	send := func(v any) error {
		payload, err := json.Marshal(v)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(websocket.TextMessage, payload)
	}

	juicefsOK := runtime.observeJuicefs(ctx)
	running := runtime.runningAgents(ctx)
	if err := send(helloMsg{
		Type:          "node.hello",
		NodeID:        cfg.nodeID,
		Hostname:      cfg.nodeID,
		JuicefsOK:     juicefsOK,
		RunningAgents: running,
	}); err != nil {
		slog.Warn("failed to send hello", "error", err.Error())
		return err
	}
	slog.Info("hello sent", "juicefsOk", juicefsOK, "runningAgents", running)

	conn.SetReadLimit(2 << 20)
	errCh := make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				if ctx.Err() == nil {
					slog.Warn("read loop terminated", "error", err.Error())
				}
				errCh <- err
				return
			}
			result := handleCommand(ctx, runtime, data)
			if result == nil {
				continue
			}
			if err := send(*result); err != nil {
				slog.Warn("failed to send command result",
					"type", headType(data),
					"requestId", result.RequestID,
					"error", err.Error())
				errCh <- err
				return
			}
			slog.Debug("command result sent",
				"type", headType(data),
				"requestId", result.RequestID,
				"ok", result.OK)
		}
	}()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errCh:
			return err
		case <-ticker.C:
			juicefsOK := runtime.observeJuicefs(ctx)
			running := runtime.runningAgents(ctx)
			if err := send(heartbeatMsg{
				Type:          "node.heartbeat",
				NodeID:        cfg.nodeID,
				JuicefsOK:     juicefsOK,
				RunningAgents: running,
			}); err != nil {
				slog.Warn("failed to send heartbeat",
					"juicefsOk", juicefsOK, "runningAgents", running, "error", err.Error())
				return err
			}
			slog.Debug("heartbeat sent", "juicefsOk", juicefsOK, "runningAgents", running)
		}
	}
}

func handleCommand(ctx context.Context, runtime *dockerRuntime, data []byte) (result *resultMsg) {
	var head struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("panic while handling node command",
				"type", head.Type,
				"agentId", requestAgentID(data),
				"panic", r,
				"stack", string(debug.Stack()))
			out := resultFail(head.RequestID, "internal error")
			result = &out
		}
	}()
	if err := json.Unmarshal(data, &head); err != nil {
		slog.Warn("invalid node command", "error", err.Error())
		return nil
	}
	switch head.Type {
	case "node.start":
		var cmd startCommand
		if err := json.Unmarshal(data, &cmd); err != nil {
			return ptr(resultFail(cmd.RequestID, "invalid start command"))
		}
		slog.Info("starting agent workspace", "agentId", cmd.AgentID)
		handle, err := runtime.start(ctx, cmd)
		if err != nil {
			slog.Warn("failed to start agent workspace", "agentId", cmd.AgentID, "error", err.Error())
			out := resultFail(cmd.RequestID, err.Error())
			return &out
		}
		slog.Info("agent workspace started", "agentId", cmd.AgentID, "containerId", handle.containerID)
		out := resultOK(cmd.RequestID, handle.containerID, handle.containerName, handle.volumeName, "running")
		return &out
	case "node.stop":
		var cmd stopCommand
		if err := json.Unmarshal(data, &cmd); err != nil {
			return ptr(resultFail(cmd.RequestID, "invalid stop command"))
		}
		slog.Info("stopping agent workspace", "agentId", cmd.AgentID)
		if err := runtime.stop(ctx, cmd.AgentID); err != nil {
			slog.Warn("failed to stop agent workspace", "agentId", cmd.AgentID, "error", err.Error())
			out := resultFail(cmd.RequestID, err.Error())
			return &out
		}
		out := resultOK(cmd.RequestID, "", "", "", "exited")
		return &out
	case "node.inspect":
		var cmd inspectCommand
		if err := json.Unmarshal(data, &cmd); err != nil {
			return ptr(resultFail(cmd.RequestID, "invalid inspect command"))
		}
		handle, state, exit, found, err := runtime.inspectAgent(ctx, cmd.AgentID)
		if err != nil {
			slog.Warn("failed to inspect agent workspace",
				"agentId", cmd.AgentID, "requestId", cmd.RequestID, "error", err.Error())
			out := resultFail(cmd.RequestID, err.Error())
			return &out
		}
		if !found {
			slog.Debug("agent workspace not found on node",
				"agentId", cmd.AgentID, "requestId", cmd.RequestID)
			out := resultOK(cmd.RequestID, "", "", "", "")
			return &out
		}
		slog.Debug("agent workspace inspected",
			"agentId", cmd.AgentID, "requestId", cmd.RequestID,
			"state", state)
		out := resultOK(cmd.RequestID, handle.containerID, handle.containerName, handle.volumeName, state)
		out.ExitCode = exit
		return &out
	default:
		return nil
	}
}

func headType(data []byte) string {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return ""
	}
	return probe.Type
}

func requestAgentID(data []byte) string {
	var probe struct {
		AgentID string `json:"agentId"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return ""
	}
	return probe.AgentID
}

func websocketURL(base, nodeID string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		parsed.Scheme = "wss"
	default:
		parsed.Scheme = "ws"
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + "/internal/v2/nodes/ws"
	query := parsed.Query()
	query.Set("nodeId", nodeID)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func ptr[T any](v T) *T { return &v }
