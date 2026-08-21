package main

type helloMsg struct {
	Type          string `json:"type"`
	NodeID        string `json:"nodeId"`
	Hostname      string `json:"hostname"`
	JuicefsOK     bool   `json:"juicefsOk"`
	RunningAgents int    `json:"runningAgents"`
}

type heartbeatMsg struct {
	Type          string `json:"type"`
	NodeID        string `json:"nodeId"`
	JuicefsOK     bool   `json:"juicefsOk"`
	RunningAgents int    `json:"runningAgents"`
}

type startCommand struct {
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
	AgentID         string `json:"agentId"`
	AgentToken      string `json:"agentToken"`
	ControlPlaneURL string `json:"controlPlaneUrl"`
	CPUMillis       int    `json:"cpuMillis"`
	MemoryBytes     int64  `json:"memoryBytes"`
	MaxPids         int    `json:"maxPids"`
}

type stopCommand struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	AgentID   string `json:"agentId"`
}

type inspectCommand struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	AgentID   string `json:"agentId"`
}

type resultMsg struct {
	Type          string `json:"type"`
	RequestID     string `json:"requestId"`
	OK            bool   `json:"ok"`
	Error         string `json:"error,omitempty"`
	ContainerID   string `json:"containerId,omitempty"`
	ContainerName string `json:"containerName,omitempty"`
	VolumeName    string `json:"volumeName,omitempty"`
	State         string `json:"state,omitempty"`
	ExitCode      *int   `json:"exitCode,omitempty"`
}

func resultOK(requestID, containerID, containerName, volumeName, state string) resultMsg {
	return resultMsg{
		Type:          "node.result",
		RequestID:     requestID,
		OK:            true,
		ContainerID:   containerID,
		ContainerName: containerName,
		VolumeName:    volumeName,
		State:         state,
	}
}

func resultFail(requestID, err string) resultMsg {
	return resultMsg{Type: "node.result", RequestID: requestID, OK: false, Error: err}
}
