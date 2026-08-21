package com.kross.identity.dto;

import java.util.List;

public record MeResponse(UserProfileView user, List<MembershipView> memberships, boolean canAccessAdmin) {}
