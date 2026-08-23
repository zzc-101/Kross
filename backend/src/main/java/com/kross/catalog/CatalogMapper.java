package com.kross.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.catalog.entity.AuditEvent;
import com.kross.catalog.entity.CredentialHandle;
import com.kross.catalog.entity.ModelProfile;
import com.kross.catalog.entity.TokenUsageTotals;
import com.kross.catalog.entity.TokenUsageRankRow;
import com.kross.catalog.entity.TokenUsageTrendRow;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface CatalogMapper {
  List<CredentialHandle> listCredentials(@Param("limit") int limit, @Param("offset") int offset);

  void insertCredential(CredentialHandle row);

  int updateCredential(CredentialHandle row);

  int deleteCredential(@Param("id") String id);

  List<ModelProfile> listModels(@Param("limit") int limit, @Param("offset") int offset);

  Optional<ModelProfile> findModel(@Param("id") String id);

  void insertModel(ModelProfile row);

  int updateModel(ModelProfile row);

  int deleteModel(@Param("id") String id);

  TokenUsageTotals tokenUsage(@Param("days") int days, @Param("organizationId") String organizationId);

  List<TokenUsageTrendRow> tokenUsageTrend(
      @Param("days") int days, @Param("organizationId") String organizationId);

  List<TokenUsageRankRow> tokenUsageByOrganization(
      @Param("days") int days, @Param("organizationId") String organizationId);

  List<TokenUsageRankRow> tokenUsageByUser(
      @Param("days") int days, @Param("organizationId") String organizationId);

  List<TokenUsageRankRow> tokenUsageByModel(
      @Param("days") int days, @Param("organizationId") String organizationId);

  Optional<String> findCredentialId(@Param("id") String id);

  List<AuditEvent> listAudit(
      @Param("organizationId") String organizationId,
      @Param("action") String action,
      @Param("resourceType") String resourceType,
      @Param("limit") int limit,
      @Param("offset") int offset);

  void insertAudit(
      @Param("organizationId") String organizationId,
      @Param("actorUserId") String actorUserId,
      @Param("action") String action,
      @Param("resourceType") String resourceType,
      @Param("resourceId") String resourceId,
      @Param("payload") JsonNode payload);
}
