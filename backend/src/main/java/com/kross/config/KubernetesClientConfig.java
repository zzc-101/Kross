package com.kross.config;

import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "kubernetes")
public class KubernetesClientConfig {
  @Bean(destroyMethod = "close")
  KubernetesClient kubernetesClient() {
    return new KubernetesClientBuilder().build();
  }
}
