package com.kross.agent.dto;

import java.util.List;

public record GitStatusView(
    String path,
    boolean repository,
    String branch,
    boolean dirty,
    List<GitFileView> files) {}
