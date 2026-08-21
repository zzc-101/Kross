package main

import (
	"context"
	"log/slog"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

const juicefsComposeService = "juicefs"

func (d *dockerRuntime) observeJuicefs(ctx context.Context) bool {
	if d.cfg.workerStorage != "juicefs" {
		return true
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	info, ok := d.findJuicefs(ctx)
	if !ok || !juicefsContainerHealthy(info) {
		d.juicefsToken = ""
		return false
	}
	token := juicefsInstanceToken(info)
	if d.juicefsToken != "" && token != d.juicefsToken {
		d.recycleWorkersLocked(ctx)
	}
	d.juicefsToken = token
	return true
}

func (d *dockerRuntime) juicefsHealthyLocked(ctx context.Context) bool {
	if d.cfg.workerStorage != "juicefs" {
		return true
	}
	info, ok := d.findJuicefs(ctx)
	return ok && juicefsContainerHealthy(info)
}

func (d *dockerRuntime) findJuicefs(ctx context.Context) (types.ContainerJSON, bool) {
	listed, err := d.cli.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", "com.docker.compose.service="+juicefsComposeService)),
	})
	if err != nil || len(listed) == 0 {
		listed, err = d.cli.ContainerList(ctx, container.ListOptions{
			Filters: filters.NewArgs(filters.Arg("name", "juicefs")),
		})
	}
	if err != nil || len(listed) == 0 {
		return types.ContainerJSON{}, false
	}
	for _, item := range listed {
		info, err := d.cli.ContainerInspect(ctx, item.ID)
		if err != nil {
			continue
		}
		if juicefsContainerHealthy(info) {
			return info, true
		}
	}
	info, err := d.cli.ContainerInspect(ctx, listed[0].ID)
	if err != nil {
		return types.ContainerJSON{}, false
	}
	return info, true
}

func juicefsContainerHealthy(info types.ContainerJSON) bool {
	if info.State == nil || !info.State.Running {
		return false
	}
	if info.State.Health == nil {
		return true
	}
	return strings.EqualFold(info.State.Health.Status, "healthy")
}

func juicefsInstanceToken(info types.ContainerJSON) string {
	started := ""
	if info.State != nil {
		started = info.State.StartedAt
	}
	return info.ID + ":" + started
}

func (d *dockerRuntime) recycleWorkersLocked(ctx context.Context) {
	listed, err := d.cli.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(
			filters.Arg("status", "running"),
			filters.Arg("label", managerLabel+"="+d.cfg.orchestratorManagerID),
		),
	})
	if err != nil || len(listed) == 0 {
		return
	}
	slog.Warn("JuiceFS remounted; recycling local workers", "count", len(listed))
	for _, item := range listed {
		_ = d.cli.ContainerRemove(ctx, item.ID, container.RemoveOptions{Force: true})
	}
}
