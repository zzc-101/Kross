package com.kross;

import com.kross.config.AppProperties;
import org.apache.ibatis.annotations.Mapper;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@MapperScan(basePackages = "com.kross", annotationClass = Mapper.class)
@EnableConfigurationProperties(AppProperties.class)
public class ControlPlaneApplication {
  public static void main(String[] args) {
    SpringApplication.run(ControlPlaneApplication.class, args);
  }
}
