package com.kross.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.Res;
import com.kross.config.KrossProperties;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@RequiredArgsConstructor
public class SecurityConfig {
  private final KrossProperties properties;
  private final ObjectMapper mapper;

  @Bean
  SecurityFilterChain securityFilterChain(HttpSecurity http, IdentityFilter identityFilter) throws Exception {
    String api = properties.getApi().getPrefix();
    return http
        .csrf(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .formLogin(AbstractHttpConfigurer::disable)
        .logout(AbstractHttpConfigurer::disable)
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
        .exceptionHandling(handler -> handler
            .authenticationEntryPoint((request, response, error) -> writeError(response, 401, "Sign in required"))
            .accessDeniedHandler((request, response, error) -> writeError(response, 403, "Access denied")))
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/health").permitAll()
            .requestMatchers("/internal/v2/agents/**", "/internal/v2/nodes/**").permitAll()
            .requestMatchers(HttpMethod.GET, api + "/auth/config").permitAll()
            .requestMatchers(HttpMethod.GET, api + "/auth/sso/start", api + "/auth/sso/callback").permitAll()
            .requestMatchers(HttpMethod.GET, api + "/auth/invites/*").permitAll()
            .requestMatchers(HttpMethod.POST, api + "/auth/invites/*/accept").permitAll()
            .requestMatchers(HttpMethod.POST, api + "/auth/register", api + "/auth/login", api + "/auth/logout")
            .permitAll()
            .requestMatchers(api + "/**").authenticated()
            .anyRequest().denyAll())
        .addFilterBefore(identityFilter, UsernamePasswordAuthenticationFilter.class)
        .build();
  }

  private void writeError(HttpServletResponse response, int status, String message) throws IOException {
    response.setStatus(status);
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    mapper.writeValue(response.getOutputStream(), Res.fail(status, message));
  }
}
