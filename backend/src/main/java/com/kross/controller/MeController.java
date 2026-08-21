package com.kross.controller;

import com.kross.api.Res;
import com.kross.identity.IdentityService;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.MeResponse;
import com.kross.identity.dto.UpdateProfileRequest;
import com.kross.security.AuthSessions;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
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

  @PatchMapping
  public Res<MeResponse> update(@RequestBody UpdateProfileRequest request, HttpServletRequest http) {
    MeResponse me = identities.updateProfile(request);
    AuthSessions.refresh(http, IdentityViews.identity(me.user()));
    return Res.ok(me);
  }
}
