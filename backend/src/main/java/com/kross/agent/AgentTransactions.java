package com.kross.agent;

import com.kross.observability.RequestLogContext;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Component
class AgentTransactions {
  void afterCommit(Runnable action) {
    Runnable traced = RequestLogContext.propagate(action);
    if (TransactionSynchronizationManager.isActualTransactionActive()) {
      TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
          traced.run();
        }
      });
      return;
    }
    traced.run();
  }
}
