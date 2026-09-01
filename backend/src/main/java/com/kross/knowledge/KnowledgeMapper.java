package com.kross.knowledge;

import com.kross.knowledge.entity.KnowledgeDocument;
import com.kross.knowledge.entity.KnowledgeJob;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface KnowledgeMapper {
  List<String> listSearchableSpaceIds(@Param("organizationId") String organizationId);

  void insertDocument(KnowledgeDocument row);

  Optional<KnowledgeDocument> findDocument(@Param("id") String id);

  List<KnowledgeDocument> listDocuments(
      @Param("spaceId") String spaceId, @Param("limit") int limit, @Param("offset") int offset);

  int countDocuments(@Param("spaceId") String spaceId);

  int updateDocumentStatus(
      @Param("id") String id,
      @Param("status") String status,
      @Param("errorMessage") String errorMessage,
      @Param("published") boolean published);

  void insertJob(KnowledgeJob row);

  Optional<KnowledgeJob> findJob(@Param("id") String id);

  int updateJob(
      @Param("id") String id, @Param("status") String status, @Param("errorMessage") String errorMessage);
}
