package com.kross.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.ALWAYS)
public class Res<T> {
  public static final int OK = 0;

  private int code;
  private String message;
  private T data;

  public static <T> Res<T> ok(T data) {
    return new Res<>(OK, "ok", data);
  }

  public static Res<Void> ok() {
    return new Res<>(OK, "ok", null);
  }

  public static <T> Res<T> fail(int code, String message) {
    return new Res<>(code, message, null);
  }
}
