FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /src
COPY backend/mvnw backend/pom.xml ./
COPY backend/.mvn .mvn
COPY backend/src src
RUN chmod +x mvnw && ./mvnw -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/kross-control-plane.jar app.jar
EXPOSE 8787
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
