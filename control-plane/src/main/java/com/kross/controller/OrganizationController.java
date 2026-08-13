package com.kross.controller;

import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.identity.IdentityService;
import com.kross.identity.dto.MembershipView;
import com.kross.identity.dto.OrganizationView;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/organizations")
public class OrganizationController {
  private final IdentityService identities;

  @GetMapping
  public Res<ItemList<MembershipView>> list() {
    return Res.ok(new ItemList<>(identities.me().memberships()));
  }

  @GetMapping("/{organizationId}")
  public Res<OrganizationView> get(@PathVariable String organizationId) {
    return Res.ok(identities.getOrganization(organizationId));
  }
}
