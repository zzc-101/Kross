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
  CONNECTOR_MANAGE("connector.manage"),
  PROJECT_READ("project.read"),
  PROJECT_CREATE("project.create"),
  PROJECT_UPDATE("project.update"),
  PROJECT_DELETE("project.delete"),
  SOURCE_READ("source.read"),
  SOURCE_CREATE("source.create"),
  SOURCE_DELETE("source.delete"),
  TASK_READ("task.read"),
  TASK_CREATE("task.create"),
  TASK_UPDATE("task.update"),
  TASK_CANCEL("task.cancel"),
  TASK_ARCHIVE("task.archive"),
  RUN_READ("run.read"),
  RUN_CREATE("run.create"),
  RUN_CANCEL("run.cancel"),
  APPROVAL_READ("approval.read"),
  APPROVAL_DECIDE("approval.decide"),
  ARTIFACT_READ("artifact.read"),
  ARTIFACT_DELETE("artifact.delete"),
  SCHEDULE_READ("schedule.read"),
  SCHEDULE_MANAGE("schedule.manage"),
  AUDIT_READ("audit.read");

  private final String wire;

  OrganizationAction(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }
}
