package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
)

const (
	agentLabel   = "dev.kross.agent.id"
	managerLabel = "dev.kross.agent.manager"
	volumeLabel  = "dev.kross.agent.volume"
)

type dockerRuntime struct {
	cli *client.Client
	cfg config
}

type handle struct {
	containerID   string
	containerName string
	volumeName    string
}

func newDockerRuntime(cfg config) (*dockerRuntime, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := cli.Ping(ctx); err != nil {
		_ = cli.Close()
		return nil, fmt.Errorf("docker is unreachable: %w", err)
	}
	return &dockerRuntime{cli: cli, cfg: cfg}, nil
}

func (d *dockerRuntime) start(ctx context.Context, cmd startCommand) (handle, error) {
	names := agentNames(cmd.AgentID)
	if err := d.ensureVolume(ctx, cmd.AgentID, names.volumeName); err != nil {
		return handle{}, err
	}
	if existing, err := d.inspect(ctx, names.containerName); err == nil {
		_ = d.cli.ContainerRemove(ctx, existing.ID, container.RemoveOptions{Force: true})
	}
	memory := cmd.MemoryBytes
	pids := int64(cmd.MaxPids)
	init := true
	host := &container.HostConfig{
		Resources: container.Resources{
			Memory:     memory,
			MemorySwap: memory,
			NanoCPUs:   int64(cmd.CPUMillis) * 1_000_000,
			PidsLimit:  &pids,
		},
		CapDrop:       []string{"ALL"},
		CapAdd:        []string{"CHOWN", "SETUID", "SETGID"},
		SecurityOpt:   []string{"no-new-privileges:true"},
		Init:          &init,
		AutoRemove:    false,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyMode("no")},
		Mounts:        []mount.Mount{d.workMount(cmd.AgentID, names.volumeName, true)},
	}
	resp, err := d.createWorker(ctx, cmd, names.containerName, host)
	if err != nil && d.cfg.workerStorage == "juicefs" && isSharedMountError(err) {
		host.Mounts = []mount.Mount{d.workMount(cmd.AgentID, names.volumeName, false)}
		resp, err = d.createWorker(ctx, cmd, names.containerName, host)
	}
	if err != nil {
		return handle{}, err
	}
	if err := d.cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return handle{}, err
	}
	return handle{containerID: resp.ID, containerName: names.containerName, volumeName: names.volumeName}, nil
}

func (d *dockerRuntime) stop(ctx context.Context, agentID string) error {
	names := agentNames(agentID)
	info, err := d.inspect(ctx, names.containerName)
	if err != nil {
		if errdefs.IsNotFound(err) {
			return nil
		}
		return err
	}
	if info.State != nil && info.State.Running {
		timeout := 15
		return d.cli.ContainerStop(ctx, info.ID, container.StopOptions{Timeout: &timeout})
	}
	return nil
}

func (d *dockerRuntime) inspectAgent(ctx context.Context, agentID string) (handle, string, *int, bool, error) {
	names := agentNames(agentID)
	info, err := d.inspect(ctx, names.containerName)
	if err != nil {
		if errdefs.IsNotFound(err) {
			return handle{}, "", nil, false, nil
		}
		return handle{}, "", nil, false, err
	}
	running := info.State != nil && info.State.Running
	status := ""
	if info.State != nil {
		status = info.State.Status
	}
	mapped := "exited"
	if running {
		mapped = "running"
	} else if status == "created" {
		mapped = "created"
	}
	var exit *int
	if !running && info.State != nil {
		code := info.State.ExitCode
		exit = &code
	}
	return handle{containerID: info.ID, containerName: names.containerName, volumeName: names.volumeName}, mapped, exit, true, nil
}

func (d *dockerRuntime) runningAgents(ctx context.Context) int {
	out, err := d.cli.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(
			filters.Arg("status", "running"),
			filters.Arg("label", managerLabel+"="+d.cfg.orchestratorManagerID),
		),
	})
	if err != nil {
		return 0
	}
	return len(out)
}

func (d *dockerRuntime) ensureVolume(ctx context.Context, agentID, volumeName string) error {
	if d.cfg.workerStorage == "juicefs" {
		dir, err := agentDirectory(d.cfg.juicefsMount, agentID)
		if err != nil {
			return err
		}
		return os.MkdirAll(dir, 0o755)
	}
	_, err := d.cli.VolumeInspect(ctx, volumeName)
	if err == nil {
		return nil
	}
	if !errdefs.IsNotFound(err) {
		return err
	}
	_, err = d.cli.VolumeCreate(ctx, volume.CreateOptions{
		Name:   volumeName,
		Driver: "local",
		Labels: map[string]string{
			agentLabel:   agentID,
			managerLabel: d.cfg.orchestratorManagerID,
			volumeLabel:  "true",
		},
	})
	return err
}

func (d *dockerRuntime) createWorker(ctx context.Context, cmd startCommand, name string, host *container.HostConfig) (container.CreateResponse, error) {
	timeout := 15
	return d.cli.ContainerCreate(ctx, &container.Config{
		Image:       d.cfg.workerImage,
		WorkingDir:  "/work",
		StopTimeout: &timeout,
		Labels: map[string]string{
			agentLabel:   cmd.AgentID,
			managerLabel: d.cfg.orchestratorManagerID,
		},
		Env: []string{
			"KROSS_AGENT_ID=" + cmd.AgentID,
			"KROSS_AGENT_TOKEN=" + cmd.AgentToken,
			"KROSS_CONTROL_PLANE_URL=" + cmd.ControlPlaneURL,
			"KROSS_PHYSICAL_WORK_ROOT=/work",
		},
	}, host, nil, nil, name)
}

func isSharedMountError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "shared mount") || strings.Contains(msg, "rshared")
}

func (d *dockerRuntime) workMount(agentID, volumeName string, rshared bool) mount.Mount {
	if d.cfg.workerStorage == "juicefs" {
		dir, _ := agentDirectory(d.cfg.juicefsMount, agentID)
		item := mount.Mount{
			Type:   mount.TypeBind,
			Source: dir,
			Target: "/work",
		}
		if rshared {
			item.BindOptions = &mount.BindOptions{Propagation: mount.PropagationRShared}
		}
		return item
	}
	return mount.Mount{Type: mount.TypeVolume, Source: volumeName, Target: "/work"}
}

func (d *dockerRuntime) inspect(ctx context.Context, name string) (types.ContainerJSON, error) {
	return d.cli.ContainerInspect(ctx, name)
}

type names struct {
	containerName string
	volumeName    string
}

func agentNames(agentID string) names {
	sum := sha256.Sum256([]byte(agentID))
	short := hex.EncodeToString(sum[:])[:16]
	return names{
		containerName: "kross-agent-" + short,
		volumeName:    "kross-agent-vol-" + short,
	}
}

func agentDirectory(mountPath, agentID string) (string, error) {
	root, err := filepath.Abs(mountPath)
	if err != nil {
		return "", err
	}
	root = filepath.Clean(root)
	dir := filepath.Clean(filepath.Join(root, "agents", agentID))
	rel, err := filepath.Rel(root, dir)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("invalid agent workspace path")
	}
	return dir, nil
}
