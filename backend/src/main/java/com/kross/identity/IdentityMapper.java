package com.kross.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.identity.entity.DashboardCounts;
import com.kross.identity.entity.Member;
import com.kross.identity.entity.Membership;
import com.kross.identity.entity.Organization;
import com.kross.identity.entity.OrganizationListRow;
import com.kross.identity.entity.PlatformSettings;
import com.kross.identity.entity.User;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface IdentityMapper {
  void upsertUser(
      @Param("id") String id, @Param("username") String username, @Param("displayName") String displayName);

  void insertUser(
      @Param("id") String id,
      @Param("username") String username,
      @Param("displayName") String displayName,
      @Param("passwordHash") String passwordHash,
      @Param("platformRole") String platformRole,
      @Param("email") String email,
      @Param("ssoIssuer") String ssoIssuer,
      @Param("ssoSubject") String ssoSubject,
      @Param("avatarUrl") String avatarUrl);

  void bindSso(
      @Param("id") String id,
      @Param("email") String email,
      @Param("ssoIssuer") String ssoIssuer,
      @Param("ssoSubject") String ssoSubject,
      @Param("displayName") String displayName,
      @Param("avatarUrl") String avatarUrl);

  void updateProfile(
      @Param("id") String id,
      @Param("displayName") String displayName,
      @Param("setAvatar") boolean setAvatar,
      @Param("avatarUrl") String avatarUrl,
      @Param("gender") String gender,
      @Param("setPhone") boolean setPhone,
      @Param("phone") String phone);

  Optional<User> findUserByUsername(@Param("username") String username);

  Optional<User> findUserByEmail(@Param("email") String email);

  Optional<User> findUserBySso(@Param("issuer") String issuer, @Param("subject") String subject);

  Optional<User> findUserById(@Param("id") String id);

  int countUsers();

  boolean isRegistrationEnabled();

  boolean isSsoEnabled();

  Optional<PlatformSettings> findPlatformSettings();

  void setRegistrationEnabled(@Param("enabled") boolean enabled);

  void updateSsoSettings(
      @Param("enabled") boolean enabled,
      @Param("displayName") String displayName,
      @Param("issuer") String issuer,
      @Param("clientId") String clientId,
      @Param("clientSecretCipher") String clientSecretCipher);

  List<User> listUsers(@Param("limit") int limit, @Param("offset") int offset);

  Optional<Membership> findActiveMembership(
      @Param("organizationId") String organizationId, @Param("userId") String userId);

  Optional<Membership> findMembershipByUser(
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

  int countActiveAdmins(
      @Param("organizationId") String organizationId, @Param("excludingId") String excludingId);

  List<OrganizationListRow> listOrganizations(@Param("limit") int limit, @Param("offset") int offset);

  Optional<OrganizationListRow> findOrganizationRow(@Param("id") String id);

  int updateOrganization(
      @Param("id") String id, @Param("name") String name, @Param("status") String status);

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
