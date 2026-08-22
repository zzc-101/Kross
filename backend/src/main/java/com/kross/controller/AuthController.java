package com.kross.controller;

import com.kross.agent.AgentService;
import com.kross.api.ApiException;
import com.kross.api.Res;
import com.kross.identity.AuthLogService;
import com.kross.identity.AuthService;
import com.kross.identity.SsoService;
import com.kross.identity.dto.AcceptInviteRequest;
import com.kross.identity.dto.AuthConfigView;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.InvitePreviewView;
import com.kross.identity.dto.LoginRequest;
import com.kross.identity.dto.MeResponse;
import com.kross.identity.dto.MembershipView;
import com.kross.identity.dto.RegisterRequest;
import com.kross.identity.entity.User;
import com.kross.security.AuthSessions;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/auth")
public class AuthController {
  private final AuthService auth;
  private final AuthLogService authLogs;
  private final SsoService sso;
  private final AgentService agents;

  @GetMapping("/config")
  public Res<AuthConfigView> config() {
    return Res.ok(auth.config());
  }

  @PostMapping("/register")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<MeResponse> register(@RequestBody RegisterRequest request, HttpServletRequest http) {
    MeResponse me = auth.register(request);
    AuthSessions.establish(http, IdentityViews.identity(me.user()));
    wakeWorkspace(me);
    return Res.ok(me);
  }

  @PostMapping("/login")
  public Res<MeResponse> login(@RequestBody LoginRequest request, HttpServletRequest http) {
    try {
      MeResponse me = auth.login(request);
      AuthSessions.establish(http, IdentityViews.identity(me.user()));
      authLogs.record(
          http,
          "login",
          "password",
          "success",
          Optional.ofNullable(me.user().username()),
          Optional.ofNullable(me.user().userId()),
          Optional.empty());
      wakeWorkspace(me);
      return Res.ok(me);
    } catch (ApiException failed) {
      authLogs.record(
          http,
          "login",
          "password",
          "failure",
          Optional.ofNullable(request.username()),
          Optional.empty(),
          Optional.ofNullable(failed.getCode()));
      throw failed;
    }
  }

  @GetMapping("/sso/start")
  public void ssoStart(HttpServletRequest http, HttpServletResponse response) throws IOException {
    response.sendRedirect(sso.start(http));
  }

  @GetMapping("/sso/callback")
  public void ssoCallback(
      HttpServletRequest http,
      HttpServletResponse response,
      @RequestParam Optional<String> code,
      @RequestParam Optional<String> state,
      @RequestParam Optional<String> error,
      @RequestParam Optional<String> error_description) throws IOException {
    try {
      if (error.filter(value -> !value.isBlank()).isPresent()) {
        throw new ApiException(
            "sso_denied",
            error_description.filter(value -> !value.isBlank()).orElse("SSO login was cancelled"),
            401);
      }
      User user = sso.complete(http, code.orElse(null), state.orElse(null));
      String next = sso.returnPath(http);
      AuthSessions.establish(http, auth.identityOf(user));
      authLogs.record(
          http,
          "login",
          "sso",
          "success",
          Optional.ofNullable(user.getUsername()),
          Optional.ofNullable(user.getId()),
          Optional.empty());
      MeResponse me = auth.current();
      wakeWorkspace(me);
      response.sendRedirect(next);
    } catch (ApiException failed) {
      authLogs.record(
          http,
          "login",
          "sso",
          "failure",
          Optional.empty(),
          Optional.empty(),
          Optional.ofNullable(failed.getCode()));
      String next = sso.returnPath(http);
      String separator = next.contains("?") ? "&" : "?";
      response.sendRedirect(next + separator + "sso_error=" + URLEncoder.encode(failed.getMessage(), StandardCharsets.UTF_8));
    }
  }

  @GetMapping("/invites/{token}")
  public Res<InvitePreviewView> previewInvite(@PathVariable String token) {
    return Res.ok(auth.previewInvite(token));
  }

  @PostMapping("/invites/{token}/accept")
  public Res<MeResponse> acceptInvite(
      @PathVariable String token,
      @RequestBody(required = false) AcceptInviteRequest request,
      HttpServletRequest http) {
    MeResponse me = auth.acceptInvite(token, Optional.ofNullable(request));
    AuthSessions.establish(http, IdentityViews.identity(me.user()));
    wakeWorkspace(me);
    return Res.ok(me);
  }

  @PostMapping("/logout")
  public Res<Void> logout(HttpServletRequest http) {
    AuthSessions.identity(http).ifPresent(current -> authLogs.record(
        http,
        "logout",
        "session",
        "success",
        Optional.ofNullable(current.username()),
        Optional.ofNullable(current.userId()),
        Optional.empty()));
    AuthSessions.clear(http);
    return Res.ok();
  }

  private void wakeWorkspace(MeResponse me) {
    Optional.ofNullable(me.memberships())
        .flatMap(items -> items.stream().map(MembershipView::organizationId).findFirst())
        .ifPresent(agents::scheduleWake);
  }
}
