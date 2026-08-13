package com.kross;

import com.kross.config.KrossProperties;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@MapperScan("com.kross")
@EnableConfigurationProperties(KrossProperties.class)
public class KrossApplication {
  public static void main(String[] args) {
    SpringApplication.run(KrossApplication.class, args);
  }
}
