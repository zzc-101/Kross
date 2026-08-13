package com.kross.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.catalog.entity.AuditEvent;
import com.kross.catalog.entity.ConnectorInstallation;
import com.kross.catalog.entity.CredentialHandle;
import com.kross.catalog.entity.ModelProfile;
import com.kross.catalog.entity.Schedule;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface CatalogMapper {
  List<CredentialHandle> listCredentials(
      @Param("organizationId") String organizationId, @Param("limit") int limit, @Param("offset") int offset);

  void insertCredential(CredentialHandle row);

  int updateCredential(CredentialHandle row);

  int deleteCredential(@Param("organizationId") String organizationId, @Param("id") String id);

  List<ModelProfile> listModels(
      @Param("organizationId") String organizationId, @Param("limit") int limit, @Param("offset") int offset);

  void insertModel(ModelProfile row);

  int updateModel(ModelProfile row);

  int deleteModel(@Param("organizationId") String organizationId, @Param("id") String id);

  Optional<String> findCredentialId(
      @Param("organizationId") String organizationId, @Param("id") String id);

  List<AuditEvent> listAudit(
      @Param("organizationId") String organizationId,
      @Param("action") String action,
      @Param("resourceType") String resourceType,
      @Param("limit") int limit,
      @Param("offset") int offset);

  List<ConnectorInstallation> listConnectors(@Param("organizationId") String organizationId);

  int insertInstallation(
      @Param("id") String id,
      @Param("organizationId") String organizationId,
      @Param("projectId") String projectId,
      @Param("definitionId") String definitionId,
      @Param("displayName") String displayName,
      @Param("credentialHandle") String credentialHandle,
      @Param("grantedScopes") JsonNode grantedScopes,
      @Param("userId") String userId);

  Optional<ConnectorInstallation> revokeInstallation(
      @Param("organizationId") String organizationId, @Param("id") String id);

  List<Schedule> listSchedules(@Param("organizationId") String organizationId);

  int insertSchedule(
      @Param("id") String id,
      @Param("organizationId") String organizationId,
      @Param("projectId") String projectId,
      @Param("taskId") String taskId,
      @Param("cron") String cron,
      @Param("timezone") String timezone,
      @Param("sourceIds") JsonNode sourceIds,
      @Param("nextRunAt") Instant nextRunAt,
      @Param("userId") String userId);

  int updateScheduleStatus(
      @Param("organizationId") String organizationId, @Param("id") String id, @Param("status") String status);
}
