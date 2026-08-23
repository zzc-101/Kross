package com.kross.identity;

public enum OrganizationAction {
  ORGANIZATION_READ("organization.read"),
  ORGANIZATION_UPDATE("organization.update"),
  ORGANIZATION_DELETE("organization.delete"),
  MEMBERSHIP_READ("membership.read"),
  MEMBERSHIP_INVITE("membership.invite"),
  MEMBERSHIP_UPDATE("membership.update"),
  MEMBERSHIP_REMOVE("membership.remove"),
  CREDENTIAL_MANAGE("credential.manage"),
  MODEL_PROFILE_MANAGE("model_profile.manage"),
  AGENT_READ("agent.read"),
  AGENT_CHAT("agent.chat"),
  AGENT_MANAGE("agent.manage"),
  SKILL_MANAGE("skill.manage"),
  TOKEN_USAGE_READ("token_usage.read"),
  AUDIT_READ("audit.read");

  private final String wire;

  OrganizationAction(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }
}
