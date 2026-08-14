package com.kross.security;

import com.kross.config.KrossProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@RequiredArgsConstructor
public class SecurityConfig {
  private final KrossProperties properties;

  @Bean
  SecurityFilterChain securityFilterChain(HttpSecurity http, DevIdentityFilter identityFilter) throws Exception {
    String apiPattern = properties.getApi().getPrefix() + "/**";
    return http
        .csrf(AbstractHttpConfigurer::disable)
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/health").permitAll()
            .requestMatchers("/internal/v2/agents/**").permitAll()
            .requestMatchers(apiPattern).authenticated()
            .anyRequest().denyAll())
        .addFilterBefore(identityFilter, UsernamePasswordAuthenticationFilter.class)
        .build();
  }
}
