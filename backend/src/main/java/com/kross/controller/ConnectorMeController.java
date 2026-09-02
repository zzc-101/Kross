package com.kross.controller;

import com.kross.api.ApiException;
import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import com.kross.config.AppProperties;
import com.kross.connector.ConnectorBindCodeView;
import com.kross.connector.ConnectorBindCodes;
import com.kross.connector.ConnectorGateway;
import com.kross.connector.ConnectorStatusView;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import java.time.Instant;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/me/connectors")
public class ConnectorMeController {
  private final OrganizationAccess access;
  private final ConnectorGateway gateway;
  private final ConnectorBindCodes bindCodes;
  private final AppProperties properties;

  @GetMapping
  public Res<ItemList<ConnectorStatusView>> list(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    boolean enabled = properties.getFeishu().isReady();
    return Res.ok(new ItemList<>(List.of(status(ConnectorGateway.FEISHU, enabled, context))));
  }

  @PostMapping("/feishu/bind-code")
  public Res<ConnectorBindCodeView> feishuBindCode(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    if (!properties.getFeishu().isReady()) {
      throw ApiException.notFound("Connector");
    }
    String code = bindCodes.issue(ConnectorGateway.FEISHU, context.userId(), context.organizationId());
    return Res.ok(new ConnectorBindCodeView(
        ConnectorGateway.FEISHU, code, Instant.now().plus(ConnectorBindCodes.TTL)));
  }

  @DeleteMapping("/feishu")
  public Res<Void> unbindFeishu(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    gateway.unbind(ConnectorGateway.FEISHU, context.userId(), context.organizationId());
    return Res.ok();
  }

  private ConnectorStatusView status(String channel, boolean enabled, OrganizationContext context) {
    return gateway.findBindingByUser(channel, context.userId(), context.organizationId())
        .map(row -> new ConnectorStatusView(channel, enabled, true, row.getCreatedAt()))
        .orElseGet(() -> new ConnectorStatusView(channel, enabled, false, null));
  }
}
