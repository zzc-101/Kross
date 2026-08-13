package com.kross.identity.dto;

import com.kross.identity.Identity;
import java.util.List;

public record MeResponse(Identity user, List<MembershipView> memberships) {}
