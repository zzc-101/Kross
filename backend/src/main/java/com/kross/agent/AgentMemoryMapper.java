package com.kross.agent;

import com.kross.agent.entity.AgentMemory;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AgentMemoryMapper {
  List<AgentMemory> listActive(
      @Param("organizationId") String organizationId, @Param("userId") String userId);

  List<AgentMemory> listForgotten(
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("limit") int limit);

  Optional<AgentMemory> findOwned(
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("id") String id);

  void insert(AgentMemory row);

  int updateContent(AgentMemory row);

  int forget(
      @Param("id") String id,
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("forgottenAt") Instant forgottenAt);
}
