package com.kross.controller;

import com.kross.api.Res;
import com.kross.identity.IdentityService;
import com.kross.identity.dto.MeResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/me")
public class MeController {
  private final IdentityService identities;

  @GetMapping
  public Res<MeResponse> me() {
    return Res.ok(identities.me());
  }
}
