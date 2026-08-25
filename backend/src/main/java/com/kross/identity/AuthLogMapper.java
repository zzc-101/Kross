package com.kross.identity;

import com.kross.identity.entity.AuthLoginEvent;
import java.time.Instant;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AuthLogMapper {
  void insert(AuthLoginEvent row);

  List<AuthLoginEvent> list(
      @Param("eventType") String eventType,
      @Param("outcome") String outcome,
      @Param("limit") int limit,
      @Param("offset") int offset);

  int countRecentPasswordFailures(
      @Param("username") String username,
      @Param("ip") String ip,
      @Param("since") Instant since);
}
