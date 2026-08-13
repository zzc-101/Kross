package com.kross.controller;

import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.catalog.AdminService;
import com.kross.catalog.dto.ConnectorView;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/connectors")
public class ConnectorController {
  private final AdminService admin;

  @GetMapping
  public Res<ItemList<ConnectorView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(admin.listConnectors(organizationId));
  }
}
