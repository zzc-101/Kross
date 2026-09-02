package com.kross.identity;

import java.util.List;
import java.util.function.Supplier;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

public final class IdentityContexts {
  private IdentityContexts() {}

  public static <T> T runAs(Identity identity, Supplier<T> action) {
    Authentication previous = SecurityContextHolder.getContext().getAuthentication();
    try {
      SecurityContextHolder.getContext().setAuthentication(
          new UsernamePasswordAuthenticationToken(identity, null, List.of()));
      return action.get();
    } finally {
      SecurityContextHolder.getContext().setAuthentication(previous);
    }
  }

}
