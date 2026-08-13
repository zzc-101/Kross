package com.kross.work;

import com.kross.work.entity.Artifact;
import com.kross.work.entity.Project;
import com.kross.work.entity.Source;
import com.kross.work.entity.Task;
import com.kross.work.entity.TaskMessage;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface WorkMapper {
  List<Project> listProjects(@Param("organizationId") String organizationId);

  Optional<Project> findProject(@Param("organizationId") String organizationId, @Param("id") String id);

  void insertProject(Project row);

  List<Task> listTasks(@Param("organizationId") String organizationId, @Param("projectId") String projectId);

  Optional<Task> findTask(@Param("organizationId") String organizationId, @Param("id") String id);

  void insertTask(Task row);

  int setLatestRun(
      @Param("organizationId") String organizationId,
      @Param("taskId") String taskId,
      @Param("runId") String runId);

  List<TaskMessage> listMessages(@Param("organizationId") String organizationId, @Param("taskId") String taskId);

  void insertMessage(TaskMessage row);

  List<Source> listSources(@Param("organizationId") String organizationId, @Param("projectId") String projectId);

  Optional<Source> findSource(@Param("organizationId") String organizationId, @Param("id") String id);

  void insertSource(Source row);

  int finalizeSource(Source row);

  List<Artifact> listArtifacts(@Param("organizationId") String organizationId, @Param("taskId") String taskId);

  Optional<Artifact> findArtifact(@Param("organizationId") String organizationId, @Param("id") String id);

  Optional<Artifact> findArtifactByReserveKey(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("key") String key);

  Optional<Artifact> findArtifactForCommit(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("id") String id);

  int insertArtifact(Artifact row);

  int commitArtifact(Artifact row);
}
