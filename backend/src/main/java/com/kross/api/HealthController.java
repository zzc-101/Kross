package com.kross.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  @GetMapping("/health")
  public HealthView health() {
    return new HealthView("ok", "control-plane");
  }
}
