package com.kross.connector;

/**
 * Channel-agnostic hook for settled agent turns. Implementations must ignore
 * conversations that have no connector thread. Token-level SSE is out of scope.
 */
public interface ConversationOutlet {
  void onTurn(ConversationTurnEvent event);
}
