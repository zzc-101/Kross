package com.kross.api;

import java.util.List;

public record PageResponse<T>(List<T> items, int page, int pageSize, int total) {}
