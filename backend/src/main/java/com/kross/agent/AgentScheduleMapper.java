package com.kross.agent;

import com.kross.agent.entity.AgentSchedule;
import com.kross.agent.entity.AgentScheduleRun;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AgentScheduleMapper {
  List<AgentSchedule> listOwned(
      @Param("organizationId") String organizationId, @Param("userId") String userId);

  Optional<AgentSchedule> findOwned(
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("id") String id);

  int countOwnedOpen(
      @Param("organizationId") String organizationId, @Param("userId") String userId);

  void insert(AgentSchedule row);

  int update(AgentSchedule row);

  int deleteOwned(
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("id") String id);

  List<AgentSchedule> lockDue(@Param("limit") int limit);

  int applyClaim(AgentSchedule row);

  void insertRun(AgentScheduleRun row);

  int finishRun(AgentScheduleRun row);

  List<AgentScheduleRun> listRuns(
      @Param("organizationId") String organizationId,
      @Param("scheduleId") String scheduleId,
      @Param("limit") int limit);

  boolean hasOpenDispatch(
      @Param("scheduleId") String scheduleId, @Param("currentRunId") String currentRunId);

  Optional<String> latestRunMessageStatus(@Param("scheduleId") String scheduleId);

  int resetFailures(
      @Param("id") String id,
      @Param("expectedStatus") String expectedStatus,
      @Param("updatedAt") Instant updatedAt);

  int recordFailure(
      @Param("id") String id,
      @Param("expectedStatus") String expectedStatus,
      @Param("status") String status,
      @Param("consecutiveFailures") int consecutiveFailures,
      @Param("updatedAt") Instant updatedAt);
}
