package com.kross.storage;

import java.time.Duration;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
public class ObjectStorageInitializer implements ApplicationRunner {
  private static final int ATTEMPTS = 20;
  private static final Duration DELAY = Duration.ofSeconds(1);
  private final ObjectStorage storage;

  public ObjectStorageInitializer(ObjectStorage storage) {
    this.storage = storage;
  }

  @Override
  public void run(ApplicationArguments args) {
    RuntimeException last = null;
    for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        storage.ensureBucket();
        return;
      } catch (RuntimeException error) {
        last = error;
        if (attempt == ATTEMPTS) {
          break;
        }
        try {
          Thread.sleep(DELAY.toMillis());
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw error;
        }
      }
    }
    throw last;
  }
}
