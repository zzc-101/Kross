package com.kross.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.api.Res;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class FilterExceptionHandler extends OncePerRequestFilter {
  private final ObjectMapper mapper;

  public FilterExceptionHandler(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    try {
      filterChain.doFilter(request, response);
    } catch (ApiException error) {
      if (response.isCommitted()) {
        throw error;
      }
      response.resetBuffer();
      response.setStatus(error.getStatus());
      response.setContentType(MediaType.APPLICATION_JSON_VALUE);
      mapper.writeValue(response.getOutputStream(), Res.fail(error.getStatus(), error.getMessage()));
    }
  }
}
