package com.kross.support;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;
import org.postgresql.util.PGobject;

@MappedTypes(JsonNode.class)
public class JsonbTypeHandler extends BaseTypeHandler<JsonNode> {
  private static final ObjectMapper MAPPER = new ObjectMapper();

  @Override
  public void setNonNullParameter(PreparedStatement ps, int i, JsonNode parameter, JdbcType jdbcType)
      throws SQLException {
    PGobject json = new PGobject();
    json.setType("jsonb");
    try {
      json.setValue(MAPPER.writeValueAsString(parameter));
    } catch (JsonProcessingException error) {
      throw new SQLException("Failed to write jsonb", error);
    }
    ps.setObject(i, json);
  }

  @Override
  public JsonNode getNullableResult(ResultSet rs, String columnName) throws SQLException {
    return parse(rs.getString(columnName));
  }

  @Override
  public JsonNode getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
    return parse(rs.getString(columnIndex));
  }

  @Override
  public JsonNode getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
    return parse(cs.getString(columnIndex));
  }

  private JsonNode parse(String value) throws SQLException {
    if (value == null) {
      return null;
    }
    try {
      return MAPPER.readTree(value);
    } catch (JsonProcessingException error) {
      throw new SQLException("Failed to read jsonb", error);
    }
  }
}
