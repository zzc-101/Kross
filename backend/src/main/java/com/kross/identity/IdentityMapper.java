package com.kross.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.identity.entity.DashboardCounts;
import com.kross.identity.entity.Member;
import com.kross.identity.entity.Membership;
import com.kross.identity.entity.Organization;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface IdentityMapper {
  void upsertUser(@Param("id") String id, @Param("displayName") String displayName);

  Optional<Membership> findActiveMembership(
      @Param("organizationId") String organizationId, @Param("userId") String userId);

  List<Membership> listMembershipsForUser(@Param("userId") String userId);

  Optional<Organization> findOrganization(@Param("id") String id);

  int countUsersWithMembership(@Param("userId") String userId);

  int countOrganizations();

  void insertOrganization(
      @Param("id") String id,
      @Param("slug") String slug,
      @Param("name") String name,
      @Param("timezone") String timezone,
      @Param("policy") JsonNode policy);

  void insertMembership(
      @Param("id") String id,
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("role") String role,
      @Param("status") String status);

  List<Member> listMembers(
      @Param("organizationId") String organizationId,
      @Param("status") String status,
      @Param("limit") int limit,
      @Param("offset") int offset);

  Optional<Member> findMember(
      @Param("organizationId") String organizationId, @Param("id") String id);

  int countActiveOwners(
      @Param("organizationId") String organizationId, @Param("excludingId") String excludingId);

  int updateMembership(
      @Param("organizationId") String organizationId,
      @Param("id") String id,
      @Param("role") String role,
      @Param("status") String status);

  int deleteMembership(@Param("organizationId") String organizationId, @Param("id") String id);

  int updatePolicy(
      @Param("id") String id,
      @Param("timezone") String timezone,
      @Param("setRetention") boolean setRetention,
      @Param("retentionDays") Integer retentionDays,
      @Param("policy") JsonNode policy);

  DashboardCounts dashboardCounts(@Param("organizationId") String organizationId);
}
