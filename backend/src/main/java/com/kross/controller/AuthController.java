package com.kross.controller;

import com.kross.agent.AgentService;
import com.kross.api.Res;
import com.kross.identity.AuthService;
import com.kross.identity.dto.AuthConfigView;
import com.kross.identity.dto.LoginRequest;
import com.kross.identity.dto.MeResponse;
import com.kross.identity.dto.MembershipView;
import com.kross.identity.dto.RegisterRequest;
import com.kross.security.AuthSessions;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/auth")
public class AuthController {
  private final AuthService auth;
  private final AgentService agents;

  @GetMapping("/config")
  public Res<AuthConfigView> config() {
    return Res.ok(auth.config());
  }

  @PostMapping("/register")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<MeResponse> register(@RequestBody RegisterRequest request, HttpServletRequest http) {
    MeResponse me = auth.register(request);
    AuthSessions.establish(http, me.user());
    wakeWorkspace(me);
    return Res.ok(me);
  }

  @PostMapping("/login")
  public Res<MeResponse> login(@RequestBody LoginRequest request, HttpServletRequest http) {
    MeResponse me = auth.login(request);
    AuthSessions.establish(http, me.user());
    wakeWorkspace(me);
    return Res.ok(me);
  }

  @PostMapping("/logout")
  public Res<Void> logout(HttpServletRequest http) {
    AuthSessions.clear(http);
    return Res.ok();
  }

  private void wakeWorkspace(MeResponse me) {
    Optional.ofNullable(me.memberships())
        .flatMap(items -> items.stream().map(MembershipView::organizationId).findFirst())
        .ifPresent(agents::scheduleWake);
  }
}
