package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	log.SetFlags(0)
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if cfg.nodeID == "" {
		cfg.nodeID = randomID()
	}
	runtime, err := newDockerRuntime(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer runtime.cli.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	for ctx.Err() == nil {
		if err := runSession(ctx, cfg, runtime); err != nil && ctx.Err() == nil {
			log.Printf("kross-node disconnected: %v", err)
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
	log.Printf("connecting kross-node %s to %s", cfg.nodeID, wsURL)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.nodeToken)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		return err
	}
	defer conn.Close()

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

	if err := send(helloMsg{
		Type:          "node.hello",
		NodeID:        cfg.nodeID,
		Hostname:      cfg.nodeID,
		JuicefsOK:     runtime.observeJuicefs(ctx),
		RunningAgents: runtime.runningAgents(ctx),
	}); err != nil {
		return err
	}

	conn.SetReadLimit(2 << 20)
	errCh := make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			result := handleCommand(ctx, runtime, data)
			if result == nil {
				continue
			}
			if err := send(*result); err != nil {
				errCh <- err
				return
			}
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
			if err := send(heartbeatMsg{
				Type:          "node.heartbeat",
				NodeID:        cfg.nodeID,
				JuicefsOK:     runtime.observeJuicefs(ctx),
				RunningAgents: runtime.runningAgents(ctx),
			}); err != nil {
				return err
			}
		}
	}
}

func handleCommand(ctx context.Context, runtime *dockerRuntime, data []byte) *resultMsg {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		log.Printf("invalid node command: %v", err)
		return nil
	}
	switch head.Type {
	case "node.start":
		var cmd startCommand
		if err := json.Unmarshal(data, &cmd); err != nil {
			return ptr(resultFail("", "invalid start command"))
		}
		handle, err := runtime.start(ctx, cmd)
		if err != nil {
			out := resultFail(cmd.RequestID, err.Error())
			return &out
		}
		out := resultOK(cmd.RequestID, handle.containerID, handle.containerName, handle.volumeName, "running")
		return &out
	case "node.stop":
		var cmd stopCommand
		if err := json.Unmarshal(data, &cmd); err != nil {
			return ptr(resultFail("", "invalid stop command"))
		}
		if err := runtime.stop(ctx, cmd.AgentID); err != nil {
			out := resultFail(cmd.RequestID, err.Error())
			return &out
		}
		out := resultOK(cmd.RequestID, "", "", "", "exited")
		return &out
	case "node.inspect":
		var cmd inspectCommand
		if err := json.Unmarshal(data, &cmd); err != nil {
			return ptr(resultFail("", "invalid inspect command"))
		}
		handle, state, exit, found, err := runtime.inspectAgent(ctx, cmd.AgentID)
		if err != nil {
			out := resultFail(cmd.RequestID, err.Error())
			return &out
		}
		if !found {
			out := resultOK(cmd.RequestID, "", "", "", "")
			return &out
		}
		out := resultOK(cmd.RequestID, handle.containerID, handle.containerName, handle.volumeName, state)
		out.ExitCode = exit
		return &out
	default:
		return nil
	}
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

func randomID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(raw[:])
}

func ptr[T any](v T) *T { return &v }
