package com.kross.fleet;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface WorkerNodeMapper {
  Optional<WorkerNode> findById(@Param("id") String id);

  List<WorkerNode> listOnlineSince(@Param("since") Instant since);

  void upsert(WorkerNode row);

  int markOffline(@Param("id") String id);

  int markStaleOffline(@Param("since") Instant since);
}
